/**
 * PDF processing pipeline:
 * 1. Extract text per page (pdf-parse)
 * 2. Rasterise every PDF page to PNG using pdfjs-dist + canvas (pure JS, Windows-compatible)
 * 3. Describe each page image via Gemini Vision (logos, diagrams, figures, tables, layout)
 * 4. Chunk all content (text + vision descriptions)
 * 5. Build BM25 search index
 * 6. Generate embeddings and store in Pinecone
 *
 * Why pdfjs-dist + canvas instead of pdftoppm:
 *   - pdftoppm requires poppler-utils (Linux/macOS only, not available on Windows)
 *   - pdfjs-dist is a pure JavaScript PDF renderer (same engine as Firefox)
 *   - canvas is a Node.js Canvas API implementation that pdfjs-dist renders into
 *   - Both install via npm with no system binaries required on any OS
 *
 * Install deps (if not already in package.json):
 *   npm install pdfjs-dist canvas
 *
 * Required env vars:
 *   GEMINI_API_KEY              – required for Gemini Vision page descriptions
 *
 * Optional env vars:
 *   GEMINI_VISION_ENABLED       – set to "true" to enable vision (default: false)
 *   GEMINI_VISION_MODEL         – primary model for vision (default: gemini-2.5-flash)
 *   GEMINI_VISION_FALLBACK_MODELS – fallback vision models (default: gemini-1.5-flash)
 *   GEMINI_VISION_PDF_FALLBACK  – use direct PDF->Gemini fallback when page render fails (default: true)
 *   GEMINI_VISION_MAX_PAGES     – max pages sent to Vision API per document (default: 10)
 *   GEMINI_VISION_TIMEOUT_MS    – overall timeout for the vision step (default: 90000)
 *   PDF_RASTER_SCALE            – render scale factor, 1.5 ≈ 108 DPI (default: 1.5)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse";
import { chunkDocument } from "./chunker.js";
import { buildIndex } from "./search-index.js";
import { extractTextFromImage } from "./ocr.js";
import { generateEmbeddings } from "./embedding-generator.js";
import { upsertVectors } from "./vector-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_VISION_MODEL =
  process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
const GEMINI_VISION_FALLBACK_MODELS = (
  process.env.GEMINI_VISION_FALLBACK_MODELS || "gemini-1.5-flash"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const GEMINI_VISION_PDF_FALLBACK = ["1", "true", "yes", "on"].includes(
  String(process.env.GEMINI_VISION_PDF_FALLBACK || "true").toLowerCase(),
);
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_VISION_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.GEMINI_VISION_ENABLED || "false").toLowerCase(),
);
const VISION_MAX_PAGES = parseInt(
  process.env.GEMINI_VISION_MAX_PAGES ?? "10",
  10,
);
const VISION_TOTAL_TIMEOUT_MS = parseInt(
  process.env.GEMINI_VISION_TIMEOUT_MS ?? "90000",
  10,
);

// Render scale factor. Higher = sharper but larger images and slower API calls.
// 1.5 ≈ 108 DPI  |  2.0 ≈ 144 DPI  |  2.5 ≈ 180 DPI
const RASTER_SCALE = parseFloat(process.env.PDF_RASTER_SCALE ?? "1.5");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Process a PDF document: extract text, describe pages via Gemini Vision,
 * chunk, build BM25 index, generate Pinecone embeddings.
 *
 * @param {object} db       - SQLite database instance
 * @param {number} documentId
 * @param {string} filePath - Absolute path to the PDF on disk
 */
export async function processDocument(db, documentId, filePath) {
  console.log(`[doc:${documentId}] Starting processing: ${filePath}`);

  try {
    const dataBuffer = fs.readFileSync(filePath);
    console.log(`[doc:${documentId}] Read ${dataBuffer.length} bytes`);

    // ------------------------------------------------------------------
    // Step 1 – Text extraction via pdf-parse
    // ------------------------------------------------------------------
    const pdfData = await pdfParse(dataBuffer);
    console.log(
      `[doc:${documentId}] pdf-parse: ${pdfData.numpages} pages, ${pdfData.text.length} chars`,
    );

    const textPages = splitTextIntoPages(pdfData.text, pdfData.numpages);
    let resolvedTextPages = textPages;

    // If pdf-parse did not preserve page boundaries, recover text using pdfjs per-page extraction
    // so citations and page navigation remain accurate.
    if (pdfData.numpages > 1 && textPages.length < pdfData.numpages) {
      const fallbackPages = await extractTextPagesWithPdfjs(
        dataBuffer,
        pdfData.numpages,
      );
      if (fallbackPages.length > 0) {
        resolvedTextPages = fallbackPages;
      }
    }
    console.log(
      `[doc:${documentId}] Split into ${resolvedTextPages.length} text pages`,
    );

    db.prepare("UPDATE documents SET page_count = ? WHERE id = ?").run(
      pdfData.numpages,
      documentId,
    );

    // ------------------------------------------------------------------
    // Step 2 – Legacy JPEG OCR (best-effort, kept for backward-compat)
    // ------------------------------------------------------------------
    const ocrPages = await extractAndOcrImages(dataBuffer);
    console.log(
      `[doc:${documentId}] Legacy OCR: ${ocrPages.length} image pages`,
    );

    // ------------------------------------------------------------------
    // Step 3 – Gemini Vision page descriptions (pure JS, Windows-safe)
    // ------------------------------------------------------------------
    const visionPages = await describeAllPagesWithGeminiWithTimeout(
      dataBuffer,
      pdfData.numpages,
      documentId,
    );
    console.log(
      `[doc:${documentId}] Gemini Vision: ${visionPages.length} pages described`,
    );

    // ------------------------------------------------------------------
    // Step 4 – Merge all text sources
    // ------------------------------------------------------------------
    const allTextPages = [...resolvedTextPages];
    for (const p of ocrPages) {
      if (p.text.trim()) allTextPages.push(p);
    }

    // ------------------------------------------------------------------
    // Step 5 – Chunk text and vision pages separately.
    // Vision chunks get chunk_type='vision' so the RAG layer can route
    // visual queries to them explicitly.
    // ------------------------------------------------------------------
    const textChunks = chunkDocument(allTextPages).map((c) => ({
      ...c,
      chunk_type: "text",
    }));

    const visionRawPages = visionPages.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.description,
    }));
    const visionChunks = chunkDocument(visionRawPages).map((c) => ({
      ...c,
      chunk_index: textChunks.length + c.chunk_index,
      chunk_type: "vision",
    }));

    const allChunks = [...textChunks, ...visionChunks];

    console.log(
      `[doc:${documentId}] Chunks: ${textChunks.length} text + ${visionChunks.length} vision = ${allChunks.length} total`,
    );

    if (allChunks.length === 0) {
      console.log(`[doc:${documentId}] No chunks created – marking ready`);
      db.prepare("UPDATE documents SET status = 'ready' WHERE id = ?").run(
        documentId,
      );
      return;
    }

    // ------------------------------------------------------------------
    // Step 6 – Persist chunks to SQLite
    // ------------------------------------------------------------------
    const insertChunk = db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, content, page_number, start_offset, end_offset, chunk_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const chunk of allChunks) {
      insertChunk.run(
        documentId,
        chunk.chunk_index,
        chunk.content,
        chunk.page_number,
        chunk.start_offset,
        chunk.end_offset,
        chunk.chunk_type,
      );
    }
    console.log(`[doc:${documentId}] Chunks inserted`);

    const savedChunks = db
      .prepare(
        "SELECT id, content, page_number FROM chunks WHERE document_id = ?",
      )
      .all(documentId);

    // ------------------------------------------------------------------
    // Step 7 – Build BM25 index
    // ------------------------------------------------------------------
    buildIndex(db, documentId, savedChunks);
    console.log(`[doc:${documentId}] BM25 index built`);

    // ------------------------------------------------------------------
    // Step 8 – Generate embeddings asynchronously (non-blocking)
    // ------------------------------------------------------------------
    generateAndStoreEmbeddings(db, documentId, savedChunks).catch((err) => {
      console.error(
        `[doc:${documentId}] Embedding error (non-fatal):`,
        err.message,
      );
    });

    db.prepare("UPDATE documents SET status = 'ready' WHERE id = ?").run(
      documentId,
    );
    console.log(`[doc:${documentId}] Processing complete`);
  } catch (err) {
    console.error(`[doc:${documentId}] Fatal error:`, err);
    db.prepare("UPDATE documents SET status = 'error' WHERE id = ?").run(
      documentId,
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// pdfjs-dist v5 initialisation helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute file:// URL to a pdfjs-dist asset.
 * This is the only reliable cross-platform approach for setting workerSrc
 * in pdfjs-dist v5 under Node.js (empty string "" no longer works in v5).
 *
 * We resolve relative to this source file so it works regardless of the
 * current working directory – important on Windows where cwd can vary.
 *
 * @param {string} relativePath - path relative to the pdfjs-dist package root
 * @returns {string} absolute file:// URL
 */
function pdfjsAssetUrl(relativePath) {
  // Walk up from this file's directory to find node_modules/pdfjs-dist
  // Handles both src/services/pdf-processor.js and flat layouts.
  const candidates = [
    path.resolve(__dirname, "../../node_modules/pdfjs-dist", relativePath),
    path.resolve(__dirname, "../node_modules/pdfjs-dist", relativePath),
    path.resolve(__dirname, "node_modules/pdfjs-dist", relativePath),
    path.resolve(process.cwd(), "node_modules/pdfjs-dist", relativePath),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // Convert to file:// URL – required by pdfjs-dist v5 on all platforms
      return new URL(`file:///${candidate.replace(/\\/g, "/")}`).href;
    }
  }

  // Last resort: just return the relative path and let pdfjs try
  return `./node_modules/pdfjs-dist/${relativePath}`;
}

/** Lazily-loaded pdfjs module (initialised once per process). */
let _pdfjsLib = null;

/**
 * Load and configure pdfjs-dist for Node.js use.
 *
 * Key differences from the browser setup:
 *  - Must use the legacy build (no DOM APIs)
 *  - Workers are disabled in Node for reliability
 *  - standardFontDataUrl and cMapUrl must point to local asset folders
 *
 * @returns {Promise<object>} configured pdfjsLib namespace
 */
async function getPdfjs() {
  if (_pdfjsLib) return _pdfjsLib;

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  _pdfjsLib = pdfjsLib;
  return pdfjsLib;
}

/**
 * Build the getDocument() options object with correct local asset URLs.
 * Without standardFontDataUrl and cMapUrl pdfjs logs warnings and may
 * render text incorrectly (glyphs missing, wrong encoding).
 *
 * @param {Uint8Array} data - PDF bytes
 * @returns {object} options for pdfjsLib.getDocument()
 */
function buildPdfjsLoadOptions(data) {
  return {
    data,
    // Node.js rendering path: disable worker thread to avoid fake-worker import issues.
    disableWorker: true,
    disableFontFace: true,
    // Suppress font-not-found warnings and enable correct text rendering
    standardFontDataUrl: pdfjsAssetUrl("standard_fonts/"),
    // Enable CMap support for CJK / special encoding PDFs
    cMapUrl: pdfjsAssetUrl("cmaps/"),
    cMapPacked: true,
    // Suppress worker verbosity
    verbosity: 0,
  };
}

// ---------------------------------------------------------------------------
// Gemini Vision – pure JS rasterisation (Windows / Linux / macOS compatible)
// ---------------------------------------------------------------------------

/**
 * Load the canvas package lazily.
 * canvas is a native addon that ships prebuilt Windows binaries via npm.
 * If it is missing we skip vision gracefully.
 *
 * @returns {Promise<{createCanvas: Function} | null>}
 */
async function getCanvas() {
  try {
    const mod = await import("canvas");
    // Handle both default and named exports
    const canvasModule = mod.default ?? mod;

    // pdfjs rendering in Node expects browser-like globals for image/canvas types.
    // Missing these can produce page render failures like: "Image or Canvas expected".
    if (canvasModule.Image && !globalThis.Image) {
      globalThis.Image = canvasModule.Image;
    }
    if (canvasModule.Canvas && !globalThis.HTMLCanvasElement) {
      globalThis.HTMLCanvasElement = canvasModule.Canvas;
    }
    if (canvasModule.ImageData && !globalThis.ImageData) {
      globalThis.ImageData = canvasModule.ImageData;
    }
    if (canvasModule.DOMMatrix && !globalThis.DOMMatrix) {
      globalThis.DOMMatrix = canvasModule.DOMMatrix;
    }
    if (canvasModule.Path2D && !globalThis.Path2D) {
      globalThis.Path2D = canvasModule.Path2D;
    }

    return canvasModule;
  } catch {
    return null;
  }
}

/**
 * Render a single pdfjs page object to a PNG Buffer using node-canvas.
 *
 * @param {object}   page         - pdfjs PDFPageProxy
 * @param {Function} createCanvas - canvas factory from the canvas package
 * @param {number}   scale        - viewport scale factor
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function renderPageToPng(page, createCanvas, scale) {
  const viewport = page.getViewport({ scale });
  const width = Math.round(viewport.width);
  const height = Math.round(viewport.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  await page.render({
    canvasContext: ctx,
    viewport,
    // pdfjs-dist requires a NodeCanvasFactory in Node.js environments
    canvasFactory: {
      create(w, h) {
        const c = createCanvas(w, h);
        return { canvas: c, context: c.getContext("2d") };
      },
      reset(pair, w, h) {
        pair.canvas.width = w;
        pair.canvas.height = h;
        pair.context = pair.canvas.getContext("2d");
      },
      destroy() {
        /* no-op – GC handles it */
      },
    },
  }).promise;

  return canvas.toBuffer("image/png");
}

/**
 * Send one PNG Buffer to the Gemini Vision API and return a rich text description.
 *
 * @param {Buffer} pngBuffer
 * @param {number} pageNumber
 * @returns {Promise<string>}
 */
async function describePageWithGemini(pngBuffer, pageNumber) {
  const base64 = pngBuffer.toString("base64");

  const prompt =
    `You are analysing page ${pageNumber} of a PDF document for retrieval indexing.\n` +
    `Return the answer in EXACT sections:\n` +
    `OBJECTS: <comma-separated nouns visible in the image, include vehicles like car/bike/bus/truck when present>\n` +
    `LOGOS_BRANDS: <logos/brand names visible, or none>\n` +
    `TEXT_OCR: <all readable text exactly as written>\n` +
    `SCENE: <short visual scene description with colors/background>\n` +
    `LAYOUT: <page layout summary>\n\n` +
    `Rules:\n` +
    `- Prioritize concrete object names over vague phrasing.\n` +
    `- If a car-like object is visible, explicitly include the word "car" in OBJECTS.\n` +
    `- If uncertain, include best guess with "(low confidence)".\n` +
    `- Do not omit key visual entities.`;

  return invokeGeminiVision([
    { text: prompt },
    { inline_data: { mime_type: "image/png", data: base64 } },
  ]);
}

/**
 * Invoke Gemini Vision with model fallback.
 * @param {Array<object>} parts
 * @returns {Promise<string>}
 */
async function invokeGeminiVision(parts) {
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };

  const candidateModels = [
    GEMINI_VISION_MODEL,
    ...GEMINI_VISION_FALLBACK_MODELS.filter((m) => m !== GEMINI_VISION_MODEL),
  ];

  let lastError = null;

  for (let i = 0; i < candidateModels.length; i++) {
    const modelName = candidateModels[i];
    const url = `${GEMINI_API_BASE}/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (response.ok) {
      const data = await response.json();
      return extractGeminiResponseText(data);
    }

    const errBody = await response.json().catch(() => ({}));
    const message =
      errBody?.error?.message || `Gemini Vision HTTP ${response.status}`;
    lastError = new Error(message);

    const canTryNextModel = i < candidateModels.length - 1;
    if (
      canTryNextModel &&
      shouldTryAnotherVisionModel(response.status, message)
    ) {
      console.warn(
        `[vision] Model ${modelName} unavailable. Trying ${candidateModels[i + 1]}...`,
      );
      continue;
    }

    throw lastError;
  }

  throw lastError || new Error("Gemini Vision failed with unknown error");
}

/**
 * Extract text from Gemini response payload.
 * @param {object} data
 * @returns {string}
 */
function extractGeminiResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

/**
 * Determine whether to retry with another vision model.
 * @param {number} status
 * @param {string} message
 * @returns {boolean}
 */
function shouldTryAnotherVisionModel(status, message) {
  const lower = String(message || "").toLowerCase();
  return (
    status === 404 ||
    lower.includes("no longer available") ||
    (lower.includes("model") && lower.includes("not found")) ||
    lower.includes("not supported for generatecontent")
  );
}

/**
 * Rasterise every page of a PDF and send each to Gemini Vision.
 *
 * Uses pdfjs-dist (pure JavaScript PDF renderer) + canvas (npm native addon).
 * No system binaries are required – works on Windows, Linux, and macOS.
 *
 * @param {Buffer} pdfBuffer
 * @param {number} numPages
 * @returns {Promise<Array<{pageNumber: number, description: string}>>}
 */
async function describeAllPagesWithGemini(pdfBuffer, numPages) {
  if (!GEMINI_VISION_ENABLED) return [];

  if (!GEMINI_API_KEY) {
    console.warn("[vision] GEMINI_API_KEY not set – skipping vision pass");
    return [];
  }

  if (VISION_MAX_PAGES === 0) {
    console.log("[vision] GEMINI_VISION_MAX_PAGES=0 – vision disabled");
    return [];
  }

  // canvas must be installed
  const canvasModule = await getCanvas();
  if (!canvasModule) {
    console.warn(
      '[vision] "canvas" package not found.\n' +
        "[vision] Run:  npm install canvas\n" +
        "[vision] Skipping vision – re-upload the document after installing.",
    );
    return [];
  }

  const { createCanvas } = canvasModule;

  // pdfjs-dist must be installed and initialisable
  let pdfjsLib;
  try {
    pdfjsLib = await getPdfjs();
  } catch (err) {
    console.warn(
      `[vision] Failed to load pdfjs-dist: ${err.message}\n` +
        "[vision] Run:  npm install pdfjs-dist\n" +
        "[vision] Skipping vision pass.",
    );
    return [];
  }

  // Parse the PDF
  let pdfDoc;
  try {
    pdfDoc = await pdfjsLib.getDocument(
      buildPdfjsLoadOptions(new Uint8Array(pdfBuffer)),
    ).promise;
  } catch (err) {
    console.warn(`[vision] pdfjs could not parse PDF: ${err.message}`);
    return [];
  }

  const pagesToProcess = Math.min(numPages, VISION_MAX_PAGES);
  const descriptions = [];
  const failedPages = [];

  for (let i = 1; i <= pagesToProcess; i++) {
    try {
      console.log(`[vision] Rendering page ${i}/${pagesToProcess}…`);
      const page = await pdfDoc.getPage(i);
      const pngBuffer = await renderPageToPng(page, createCanvas, RASTER_SCALE);
      page.cleanup();

      console.log(
        `[vision] Describing page ${i} (${(pngBuffer.length / 1024).toFixed(0)} KB PNG)…`,
      );
      const description = await describePageWithGemini(pngBuffer, i);

      if (description.length > 20) {
        descriptions.push({ pageNumber: i, description });
      }
    } catch (err) {
      // A single-page failure must never abort the whole document
      console.warn(`[vision] Page ${i} failed (skipping): ${err.message}`);
      failedPages.push(i);
    }
  }

  if (GEMINI_VISION_PDF_FALLBACK && failedPages.length > 0) {
    console.warn(
      `[vision] Attempting direct PDF fallback for pages: ${failedPages.join(", ")}...`,
    );

    try {
      const fallbackDescriptions = await describePdfWithGeminiDirect(
        pdfBuffer,
        pagesToProcess,
        failedPages,
      );

      const existingPages = new Set(descriptions.map((d) => d.pageNumber));
      for (const item of fallbackDescriptions) {
        if (!existingPages.has(item.pageNumber)) {
          descriptions.push(item);
        }
      }
    } catch (err) {
      console.warn(`[vision] Direct PDF fallback failed: ${err.message}`);
    }
  }

  console.log(
    `[vision] ${descriptions.length}/${pagesToProcess} pages described successfully`,
  );
  return descriptions;
}

/**
 * Direct PDF -> Gemini Vision fallback when page rasterization fails.
 * @param {Buffer} pdfBuffer
 * @param {number} pagesToProcess
 * @param {number[]} failedPages
 * @returns {Promise<Array<{pageNumber: number, description: string}>>}
 */
async function describePdfWithGeminiDirect(
  pdfBuffer,
  pagesToProcess,
  failedPages,
) {
  const base64 = pdfBuffer.toString("base64");
  const requestedPages = [...new Set(failedPages)].sort((a, b) => a - b);

  const prompt =
    `You are analyzing a PDF document. Focus ONLY on these pages: ${requestedPages.join(", ")} (max ${pagesToProcess}).\n` +
    `For each requested page, return this STRICT format:\n` +
    `PAGE <number>\n` +
    `OBJECTS: <comma-separated nouns visible; include vehicles like car/bike/bus/truck when present>\n` +
    `LOGOS_BRANDS: <logos/brands or none>\n` +
    `TEXT_OCR: <readable text>\n` +
    `SCENE: <short visual scene>\n` +
    `LAYOUT: <layout summary>\n` +
    `---\n` +
    `Do not include pages outside the requested list.`;

  const raw = await invokeGeminiVision([
    { text: prompt },
    { inline_data: { mime_type: "application/pdf", data: base64 } },
  ]);

  return parsePageBlocks(raw, requestedPages);
}

/**
 * Parse PAGE N: description blocks from Gemini text.
 * @param {string} text
 * @param {number[]} allowedPages
 * @returns {Array<{pageNumber: number, description: string}>}
 */
function parsePageBlocks(text, allowedPages) {
  const allowed = new Set(allowedPages);
  const results = [];

  const regex = /PAGE\s+(\d+)\s*:\s*([\s\S]*?)(?=\n\s*PAGE\s+\d+\s*:|$)/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const pageNumber = Number(match[1]);
    const description = String(match[2] || "").trim();

    if (allowed.has(pageNumber) && description.length > 20) {
      results.push({ pageNumber, description });
    }
  }

  if (
    results.length === 0 &&
    text.trim().length > 20 &&
    allowedPages.length > 0
  ) {
    // Best-effort fallback when model does not follow PAGE format strictly.
    results.push({ pageNumber: allowedPages[0], description: text.trim() });
  }

  return results;
}

/**
 * Run the vision pass with a hard overall timeout so a slow Gemini response
 * can never stall document processing indefinitely.
 *
 * @param {Buffer} pdfBuffer
 * @param {number} numPages
 * @param {number} documentId - used only for log messages
 * @returns {Promise<Array<{pageNumber: number, description: string}>>}
 */
async function describeAllPagesWithGeminiWithTimeout(
  pdfBuffer,
  numPages,
  documentId,
) {
  if (!GEMINI_VISION_ENABLED) return [];

  try {
    return await promiseWithTimeout(
      describeAllPagesWithGemini(pdfBuffer, numPages),
      VISION_TOTAL_TIMEOUT_MS,
      `[doc:${documentId}] Vision step timed out after ${VISION_TOTAL_TIMEOUT_MS}ms`,
    );
  } catch (err) {
    console.warn(err.message);
    return [];
  }
}

/**
 * Race a promise against a timeout, rejecting with a descriptive message.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number}     timeoutMs
 * @param {string}     timeoutMessage
 * @returns {Promise<T>}
 */
function promiseWithTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeoutId),
  );
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Split the concatenated text from pdf-parse back into per-page objects.
 * Uses form-feed characters (\f) if present, otherwise distributes evenly.
 */
function splitTextIntoPages(text, numPages) {
  const ffParts = text.split("\f").filter((p) => p.trim().length > 0);

  if (ffParts.length >= numPages * 0.5) {
    return ffParts.map((t, i) => ({ pageNumber: i + 1, text: t.trim() }));
  }

  if (numPages <= 1) {
    return [{ pageNumber: 1, text: text.trim() }];
  }

  const charsPerPage = Math.ceil(text.length / numPages);
  const pages = [];
  for (let i = 0; i < numPages; i++) {
    const start = i * charsPerPage;
    const end = Math.min(start + charsPerPage, text.length);
    const pageText = text.slice(start, end).trim();
    if (pageText.length > 0) {
      pages.push({ pageNumber: i + 1, text: pageText });
    }
  }
  return pages;
}

/**
 * Fallback page-wise text extraction using pdfjs, used when pdf-parse returns
 * merged text with unreliable page boundaries.
 *
 * @param {Buffer} pdfBuffer
 * @param {number} numPages
 * @returns {Promise<Array<{pageNumber: number, text: string}>>}
 */
async function extractTextPagesWithPdfjs(pdfBuffer, numPages) {
  try {
    const pdfjsLib = await getPdfjs();
    const pdfDoc = await pdfjsLib.getDocument(
      buildPdfjsLoadOptions(new Uint8Array(pdfBuffer)),
    ).promise;

    const pages = [];
    const totalPages = Math.min(numPages, pdfDoc.numPages || numPages);

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => item?.str || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 0) {
        pages.push({ pageNumber: pageNum, text });
      }
      page.cleanup();
    }

    return pages;
  } catch (err) {
    console.warn(`[text] pdfjs page extraction failed: ${err.message}`);
    return [];
  }
}

/**
 * Legacy fallback: scan raw PDF bytes for JPEG markers and OCR with Tesseract.
 * Handles embedded images that pdfjs-dist might not render (e.g. corrupt streams).
 */
async function extractAndOcrImages(pdfBuffer) {
  const ocrPages = [];

  try {
    const images = findEmbeddedJpegs(pdfBuffer);
    for (const img of images) {
      try {
        const text = await extractTextFromImage(img.buffer);
        if (text.trim().length > 10) {
          ocrPages.push({
            pageNumber: img.estimatedPage || 1,
            text: `[Image OCR] ${text.trim()}`,
          });
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* best-effort */
  }

  return ocrPages;
}

/**
 * Find JPEG blobs embedded in a raw PDF buffer by scanning for magic bytes.
 */
function findEmbeddedJpegs(buffer) {
  const images = [];
  const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
  const JPEG_END = Buffer.from([0xff, 0xd9]);
  let pos = 0;

  while (pos < buffer.length - 3) {
    const startIdx = buffer.indexOf(JPEG_START, pos);
    if (startIdx === -1) break;

    const endIdx = buffer.indexOf(JPEG_END, startIdx + 3);
    if (endIdx === -1) break;

    const imgEnd = endIdx + 2;
    const imgSize = imgEnd - startIdx;

    if (imgSize > 1024 && imgSize < 5 * 1024 * 1024) {
      images.push({ buffer: buffer.slice(startIdx, imgEnd), estimatedPage: 1 });
    }

    pos = imgEnd;
    if (images.length >= 10) break;
  }

  return images;
}

// ---------------------------------------------------------------------------
// Embedding generation
// ---------------------------------------------------------------------------

/**
 * Generate embeddings for all chunks and upsert to Pinecone.
 */
async function generateAndStoreEmbeddings(db, documentId, savedChunks) {
  if (savedChunks.length === 0) return;

  if (savedChunks.length > 50) {
    console.log(
      `[doc:${documentId}] Generating embeddings for ${savedChunks.length} chunks…`,
    );
  }

  const chunkTexts = savedChunks.map((c) => c.content);
  const embeddings = await generateEmbeddings(chunkTexts);

  const vectors = savedChunks.map((chunk, i) => ({
    id: `chunk_${chunk.id}`,
    embedding: embeddings[i],
    metadata: {
      document_id: documentId,
      chunk_id: chunk.id,
      page_number: chunk.page_number || 1,
      content_preview: chunk.content.slice(0, 500),
    },
  }));

  await upsertVectors(vectors);
  console.log(
    `[doc:${documentId}] Stored ${vectors.length} embeddings in Pinecone`,
  );
}
