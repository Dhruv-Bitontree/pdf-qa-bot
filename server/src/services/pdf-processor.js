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
 *   GEMINI_VISION_MODEL         – primary model for vision (default: gemini-3.1-flash)
 *   GEMINI_VISION_FALLBACK_MODELS – fallback vision models (default: gemini-2.5-flash,gemini-1.5-flash)
 *   GEMINI_VISION_PDF_FALLBACK  – allow raster-page fallback when direct PDF coverage is incomplete (default: true)
 *   GEMINI_VISION_MAX_PAGES     – max pages sent to Vision API per document (default: 0 = all pages)
 *   GEMINI_VISION_ADAPTIVE_PAGES – route only image-rich/scanned pages to vision (default: true)
 *   GEMINI_VISION_TEXT_THRESHOLD – text chars threshold for scanned-page fallback routing (default: 20)
 *   GEMINI_VISION_DIRECT_BATCH_SIZE – pages per direct-PDF vision request (default: 4)
 *   GEMINI_VISION_FORCE_RASTER   – force raster fallback on unsupported Node versions (default: false)
 *   GEMINI_VISION_TIMEOUT_MS    – overall timeout for the vision step (default: 90000)
 *   PDF_RASTER_SCALE            – render scale factor, 1.5 ≈ 108 DPI (default: 1.5)
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse";
import { chunkDocument } from "./chunker.js";
import { buildIndex } from "./search-index.js";
import { extractTextFromImage } from "./ocr.js";
import { generateEmbeddings } from "./embedding-generator.js";
import { upsertVectors } from "./vector-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsRootDir = path.join(__dirname, "..", "..", "uploads");
const extractedImagesDir = path.join(uploadsRootDir, "extracted-images");

const STAGE_PROGRESS = {
  started: 2,
  parsing: 10,
  text_split: 18,
  ocr: 28,
  image_extract: 38,
  vision: 54,
  chunking: 65,
  chunk_insert_start: 70,
  bm25: 82,
  embeddings: 92,
  finalizing: 98,
  complete: 100,
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TEXT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";
const GEMINI_TEXT_FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash,gemini-1.5-flash"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const GEMINI_VISION_MODEL =
  process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
const GEMINI_VISION_FALLBACK_MODELS = (
  process.env.GEMINI_VISION_FALLBACK_MODELS || "gemini-1.5-flash,gemini-1.5-pro"
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
  process.env.GEMINI_VISION_MAX_PAGES ?? "0",
  10,
);
const GEMINI_VISION_ADAPTIVE_PAGES = ["1", "true", "yes", "on"].includes(
  String(process.env.GEMINI_VISION_ADAPTIVE_PAGES || "true").toLowerCase(),
);
const GEMINI_VISION_TEXT_THRESHOLD = parseInt(
  process.env.GEMINI_VISION_TEXT_THRESHOLD ?? "20",
  10,
);
const GEMINI_VISION_DIRECT_BATCH_SIZE = Math.max(
  1,
  parseInt(process.env.GEMINI_VISION_DIRECT_BATCH_SIZE ?? "8", 10) || 8,
);
const GEMINI_VISION_FORCE_RASTER = ["1", "true", "yes", "on"].includes(
  String(process.env.GEMINI_VISION_FORCE_RASTER || "false").toLowerCase(),
);
const VISION_TOTAL_TIMEOUT_MS = parseInt(
  process.env.GEMINI_VISION_TIMEOUT_MS ?? "300000",
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
  setDocumentProgress(db, documentId, {
    status: "processing",
    processingStage: "starting",
    statusMessage: "Starting PDF processing",
    progressPercent: STAGE_PROGRESS.started,
    chunksTotal: 0,
    chunksProcessed: 0,
    extractedImageCount: 0,
  });

  try {
    const dataBuffer = fs.readFileSync(filePath);
    console.log(`[doc:${documentId}] Read ${dataBuffer.length} bytes`);
    setDocumentProgress(db, documentId, {
      processingStage: "parsing",
      statusMessage: "Parsing PDF",
      progressPercent: STAGE_PROGRESS.parsing,
    });

    // ------------------------------------------------------------------
    // Step 1 – Text extraction via pdf-parse
    // ------------------------------------------------------------------
    const pdfData = await pdfParse(dataBuffer);
    console.log(
      `[doc:${documentId}] pdf-parse: ${pdfData.numpages} pages, ${pdfData.text.length} chars`,
    );

    const textPages = splitTextIntoPages(pdfData.text, pdfData.numpages);
    let resolvedTextPages = textPages;

    // For multi-page PDFs, prefer true per-page extraction from pdfjs to avoid
    // wrong page attribution from heuristic splitting.
    if (pdfData.numpages > 1) {
      const perPageText = await extractTextPagesWithPdfjs(
        dataBuffer,
        pdfData.numpages,
      );
      if (perPageText.length > 0) {
        resolvedTextPages = perPageText;
      }
    }
    console.log(
      `[doc:${documentId}] Split into ${resolvedTextPages.length} text pages`,
    );
    setDocumentProgress(db, documentId, {
      processingStage: "text",
      statusMessage: "Extracting text by page",
      progressPercent: STAGE_PROGRESS.text_split,
    });

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
    setDocumentProgress(db, documentId, {
      processingStage: "ocr",
      statusMessage: "Running OCR on embedded images",
      progressPercent: STAGE_PROGRESS.ocr,
    });

    const extractedImageCount = await saveDetectedEmbeddedImages(
      db,
      dataBuffer,
      documentId,
    );
    setDocumentProgress(db, documentId, {
      processingStage: "image-extraction",
      statusMessage: `Detected ${extractedImageCount} extracted image${extractedImageCount === 1 ? "" : "s"}`,
      extractedImageCount,
      progressPercent: STAGE_PROGRESS.image_extract,
    });

    // ------------------------------------------------------------------
    // Step 3 – Gemini Vision page descriptions (pure JS, Windows-safe)
    // ------------------------------------------------------------------
    const visionPages = await describeAllPagesWithGeminiWithTimeout(
      db,
      dataBuffer,
      pdfData.numpages,
      documentId,
    );
    console.log(
      `[doc:${documentId}] Gemini Vision: ${visionPages.length} pages described`,
    );
    const totalExtractedImages = Number(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM extracted_images WHERE document_id = ?",
        )
        .get(documentId)?.count || 0,
    );
    setDocumentProgress(db, documentId, {
      processingStage: "vision",
      statusMessage: "Analyzing page visuals",
      extractedImageCount: totalExtractedImages,
      progressPercent: STAGE_PROGRESS.vision,
    });

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

    const visionPagesWithContext = mergeVisionDescriptionsWithImageContext(
      db,
      documentId,
      visionPages,
    );
    const visionRawPages = visionPagesWithContext.map((p) => ({
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
    setDocumentProgress(db, documentId, {
      processingStage: "chunking",
      statusMessage: `Preparing ${allChunks.length} chunks`,
      chunksTotal: allChunks.length,
      chunksProcessed: 0,
      progressPercent: STAGE_PROGRESS.chunking,
    });

    if (allChunks.length === 0) {
      console.log(`[doc:${documentId}] No chunks created – marking ready`);
      setDocumentProgress(db, documentId, {
        status: "ready",
        processingStage: "complete",
        statusMessage: "Processing complete (no chunks generated)",
        progressPercent: STAGE_PROGRESS.complete,
      });
      return;
    }

    // ------------------------------------------------------------------
    // Step 6 – Persist chunks to SQLite
    // ------------------------------------------------------------------
    const insertChunk = db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, content, page_number, start_offset, end_offset, chunk_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const totalChunks = allChunks.length;
    for (let i = 0; i < allChunks.length; i++) {
      const chunk = allChunks[i];
      insertChunk.run(
        documentId,
        chunk.chunk_index,
        chunk.content,
        chunk.page_number,
        chunk.start_offset,
        chunk.end_offset,
        chunk.chunk_type,
      );

      const processed = i + 1;
      if (processed === totalChunks || processed % 5 === 0) {
        const chunkProgress =
          STAGE_PROGRESS.chunk_insert_start +
          (processed / totalChunks) *
            (STAGE_PROGRESS.bm25 - STAGE_PROGRESS.chunk_insert_start - 2);
        setDocumentProgress(db, documentId, {
          processingStage: "chunk-insert",
          statusMessage: `Stored chunk ${processed} of ${totalChunks}`,
          chunksTotal: totalChunks,
          chunksProcessed: processed,
          progressPercent: chunkProgress,
        });
      }
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

    await updateDocumentSearchMetadata(db, documentId, savedChunks);
    setDocumentProgress(db, documentId, {
      processingStage: "indexing",
      statusMessage: "Building search index",
      progressPercent: STAGE_PROGRESS.bm25,
      chunksTotal: savedChunks.length,
      chunksProcessed: savedChunks.length,
    });

    // ------------------------------------------------------------------
    // Step 8 – Generate embeddings asynchronously (non-blocking)
    // ------------------------------------------------------------------
    setDocumentProgress(db, documentId, {
      processingStage: "embeddings",
      statusMessage: "Generating embeddings",
      progressPercent: STAGE_PROGRESS.embeddings,
    });

    await generateAndStoreEmbeddings(
      db,
      documentId,
      savedChunks,
      (fraction) => {
        const bounded = Math.min(1, Math.max(0, Number(fraction) || 0));
        const currentProgress =
          STAGE_PROGRESS.embeddings +
          bounded * (STAGE_PROGRESS.finalizing - STAGE_PROGRESS.embeddings);
        setDocumentProgress(db, documentId, {
          processingStage: "embeddings",
          statusMessage: `Embedding ${Math.round(bounded * 100)}% complete`,
          progressPercent: currentProgress,
        });
      },
    );

    setDocumentProgress(db, documentId, {
      status: "ready",
      processingStage: "complete",
      statusMessage: "Processing complete",
      progressPercent: STAGE_PROGRESS.complete,
      chunksTotal: savedChunks.length,
      chunksProcessed: savedChunks.length,
    });
    console.log(`[doc:${documentId}] Processing complete`);
  } catch (err) {
    console.error(`[doc:${documentId}] Fatal error:`, err);
    setDocumentProgress(db, documentId, {
      status: "error",
      processingStage: "error",
      statusMessage: String(err?.message || "Processing failed"),
      progressPercent: 100,
    });
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
  try {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    await page.render({
      canvasContext: ctx,
      viewport,
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
          /* no-op */
        },
      },
    }).promise;

    return canvas.toBuffer("image/png");
  } catch (err) {
    if (!String(err?.message || "").includes("Image or Canvas expected")) {
      throw err;
    }

    const fallbackCanvas = createCanvas(width, height);
    const fallbackCtx = fallbackCanvas.getContext("2d");
    await page.render({ canvasContext: fallbackCtx, viewport }).promise;
    return fallbackCanvas.toBuffer("image/png");
  }
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
 * Describe all pages with Gemini Vision.
 *
 * Primary mode: direct PDF upload to Gemini (more robust for many PDFs on Windows).
 * Secondary mode: raster-page fallback via pdfjs-dist + canvas for pages that are still
 * missing or short after the direct pass.
 *
 * @param {Buffer} pdfBuffer
 * @param {number} numPages
 * @returns {Promise<Array<{pageNumber: number, description: string}>>}
 */
async function describeAllPagesWithGemini(db, pdfBuffer, numPages, documentId) {
  if (!GEMINI_VISION_ENABLED) return [];

  if (!GEMINI_API_KEY) {
    console.warn("[vision] GEMINI_API_KEY not set – skipping vision pass");
    return [];
  }

  const pagesToProcess =
    VISION_MAX_PAGES > 0 ? Math.min(numPages, VISION_MAX_PAGES) : numPages;
  const pageSelection = await selectVisionPages(pdfBuffer, pagesToProcess);
  const requestedPages = pageSelection.visionPages;

  console.log(
    `[vision] Page routing: ${requestedPages.length}/${pagesToProcess} page(s) sent to vision (${pageSelection.skippedPages.length} text-dominant skipped)`,
  );

  if (requestedPages.length === 0) {
    return [];
  }

  const descriptions = [];
  const describedPageSet = new Set();

  try {
    console.log(
      `[vision] Direct PDF pass using ${GEMINI_VISION_MODEL} for ${requestedPages.length} page(s)...`,
    );

    const batches = chunkNumberArray(
      requestedPages,
      GEMINI_VISION_DIRECT_BATCH_SIZE,
    );

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const directDescriptions = await describePdfWithGeminiDirect(
        pdfBuffer,
        batch,
      );
      for (const item of directDescriptions) {
        if (
          item.description.length <= 20 ||
          describedPageSet.has(item.pageNumber)
        ) {
          continue;
        }
        describedPageSet.add(item.pageNumber);
        descriptions.push(item);
      }
      console.log(
        `[vision] Direct batch ${i + 1}/${batches.length}: ${describedPageSet.size}/${requestedPages.length} pages described`,
      );
    }

    console.log(
      `[vision] Direct PDF described ${descriptions.length}/${requestedPages.length} pages`,
    );
  } catch (err) {
    console.warn(`[vision] Direct PDF pass failed: ${err.message}`);
  }

  const missingPages = requestedPages.filter((p) => !describedPageSet.has(p));
  if (missingPages.length === 0) {
    console.log(
      `[vision] ${descriptions.length}/${pagesToProcess} pages described successfully`,
    );
    return descriptions.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  if (!GEMINI_VISION_PDF_FALLBACK) {
    console.warn(
      `[vision] Raster fallback disabled. Missing pages: ${missingPages.join(", ")}`,
    );
    return descriptions.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  if (!isRasterFallbackRuntimeSafe()) {
    console.warn(
      `[vision] Raster fallback disabled on Node ${process.versions.node} due pdfjs/canvas instability. Missing pages: ${missingPages.join(", ")}`,
    );
    return descriptions.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  // Secondary fallback: render only missing pages to PNG and describe them.
  const canvasModule = await getCanvas();
  if (!canvasModule) {
    console.warn(
      '[vision] "canvas" package not found; unable to run raster fallback for missing pages.',
    );
    return descriptions.sort((a, b) => a.pageNumber - b.pageNumber);
  }
  const { createCanvas } = canvasModule;

  let pdfjsLib;
  try {
    pdfjsLib = await getPdfjs();
  } catch (err) {
    console.warn(
      `[vision] pdfjs unavailable for raster fallback: ${err.message}`,
    );
    return descriptions.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  let pdfDoc;
  try {
    pdfDoc = await pdfjsLib.getDocument(
      buildPdfjsLoadOptions(new Uint8Array(pdfBuffer)),
    ).promise;
  } catch (err) {
    console.warn(
      `[vision] pdfjs could not parse PDF for raster fallback: ${err.message}`,
    );
    return descriptions.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  for (const pageNumber of missingPages) {
    try {
      console.log(
        `[vision] Raster fallback rendering page ${pageNumber}/${pagesToProcess}...`,
      );
      const page = await pdfDoc.getPage(pageNumber);
      const pngBuffer = await renderPageToPng(page, createCanvas, RASTER_SCALE);
      const description = await describePageWithGemini(pngBuffer, pageNumber);
      persistPageCaptureImage(
        db,
        documentId,
        pageNumber,
        pngBuffer,
        description,
      );
      page.cleanup();

      if (description.length > 20 && !describedPageSet.has(pageNumber)) {
        describedPageSet.add(pageNumber);
        descriptions.push({ pageNumber, description });
      }
    } catch (err) {
      console.warn(
        `[vision] Raster fallback failed for page ${pageNumber}: ${err.message}`,
      );
    }
  }

  console.log(
    `[vision] ${descriptions.length}/${pagesToProcess} pages described successfully`,
  );
  return descriptions.sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * Direct PDF -> Gemini Vision page description pass.
 * @param {Buffer} pdfBuffer
 * @param {number[]} requestedPages
 * @returns {Promise<Array<{pageNumber: number, description: string}>>}
 */
async function describePdfWithGeminiDirect(pdfBuffer, requestedPages) {
  const base64 = pdfBuffer.toString("base64");
  const normalizedPages = [...new Set(requestedPages)].sort((a, b) => a - b);

  const prompt =
    `You are analyzing a PDF document. Focus ONLY on these pages: ${normalizedPages.join(", ")}.\n` +
    `Return ONLY valid JSON as an array of objects with this schema:\n` +
    `[{"page": <number>, "objects": "...", "logos_brands": "...", "text_ocr": "...", "scene": "...", "layout": "..."}]\n` +
    `Rules:\n` +
    `- Include one object per requested page that has meaningful visual content.\n` +
    `- Do not include pages outside the requested list.\n` +
    `- Use empty string for unknown fields, not null.\n` +
    `- Do not include markdown fences.`;

  const raw = await invokeGeminiVision([
    { text: prompt },
    { inline_data: { mime_type: "application/pdf", data: base64 } },
  ]);

  return parseDirectPdfVisionResponse(raw, normalizedPages);
}

/**
 * Select pages to run through vision based on page-level signals.
 * @param {Buffer} pdfBuffer
 * @param {number} pagesToProcess
 * @returns {Promise<{visionPages:number[], skippedPages:number[]}>}
 */
async function selectVisionPages(pdfBuffer, pagesToProcess) {
  const allPages = Array.from({ length: pagesToProcess }, (_, i) => i + 1);
  if (!GEMINI_VISION_ADAPTIVE_PAGES) {
    return { visionPages: allPages, skippedPages: [] };
  }

  let pdfjsLib;
  try {
    pdfjsLib = await getPdfjs();
  } catch (err) {
    console.warn(
      `[vision] Adaptive routing disabled (pdfjs unavailable): ${err.message}`,
    );
    return { visionPages: allPages, skippedPages: [] };
  }

  let pdfDoc;
  try {
    pdfDoc = await pdfjsLib.getDocument(
      buildPdfjsLoadOptions(new Uint8Array(pdfBuffer)),
    ).promise;
  } catch (err) {
    console.warn(
      `[vision] Adaptive routing disabled (pdf parse failed): ${err.message}`,
    );
    return { visionPages: allPages, skippedPages: [] };
  }

  const imageOps = buildImageOperatorCodeSet(pdfjsLib);
  const visionPages = [];
  const skippedPages = [];

  for (const pageNumber of allPages) {
    try {
      const page = await pdfDoc.getPage(pageNumber);
      let textChars = 0;
      let hasImageOps = false;

      try {
        const textContent = await page.getTextContent();
        textChars = (textContent?.items || [])
          .map((item) => String(item?.str || ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim().length;
      } catch {
        textChars = 0;
      }

      try {
        const operatorList = await page.getOperatorList();
        hasImageOps = (operatorList?.fnArray || []).some((fn) =>
          imageOps.has(fn),
        );
      } catch {
        hasImageOps = false;
      }

      const isLikelyVisual =
        hasImageOps || textChars <= GEMINI_VISION_TEXT_THRESHOLD;

      if (isLikelyVisual) {
        visionPages.push(pageNumber);
      } else {
        skippedPages.push(pageNumber);
      }

      page.cleanup();
    } catch (err) {
      // If page analysis fails, err on the side of inclusion.
      console.warn(
        `[vision] Page ${pageNumber} analysis failed, routing to vision: ${err.message}`,
      );
      visionPages.push(pageNumber);
    }
  }

  return {
    visionPages,
    skippedPages,
  };
}

/**
 * Build operator code set that indicates image drawing operations in pdfjs.
 * @param {object} pdfjsLib
 * @returns {Set<number>}
 */
function buildImageOperatorCodeSet(pdfjsLib) {
  const ops = pdfjsLib?.OPS || {};
  const candidates = [
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
    ops.paintJpegXObject,
  ];
  return new Set(candidates.filter((v) => Number.isInteger(v)));
}

/**
 * Return whether raster fallback is safe for the current runtime.
 * Node 24 currently triggers fatal pdfjs canvas errors in this project.
 * @returns {boolean}
 */
function isRasterFallbackRuntimeSafe() {
  // Opt-out only if explicitly set to 'false'
  if (process.env.GEMINI_VISION_FORCE_RASTER === "false") return false;
  return true;
}

/**
 * Chunk an array of numbers into fixed-size groups.
 * @param {number[]} numbers
 * @param {number} size
 * @returns {number[][]}
 */
function chunkNumberArray(numbers, size) {
  const chunks = [];
  for (let i = 0; i < numbers.length; i += size) {
    chunks.push(numbers.slice(i, i + size));
  }
  return chunks;
}

/**
 * Parse direct PDF vision output from JSON-first format with text fallback.
 * @param {string} text
 * @param {number[]} allowedPages
 * @returns {Array<{pageNumber: number, description: string}>}
 */
function parseDirectPdfVisionResponse(text, allowedPages) {
  const fromJson = parseJsonVisionBlocks(text, allowedPages);
  if (fromJson.length > 0) {
    return fromJson;
  }
  return parsePageBlocks(text, allowedPages);
}

/**
 * Parse JSON array output from direct PDF vision pass.
 * @param {string} text
 * @param {number[]} allowedPages
 * @returns {Array<{pageNumber: number, description: string}>}
 */
function parseJsonVisionBlocks(text, allowedPages) {
  const allowed = new Set(allowedPages);
  const payload = extractJsonPayload(text);
  if (!payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload);
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.pages)
        ? parsed.pages
        : [];

    return rows
      .map((row) => {
        const pageNumber = Number(row?.page ?? row?.page_number ?? 0);
        const parts = [
          `OBJECTS: ${String(row?.objects || "").trim()}`,
          `LOGOS_BRANDS: ${String(row?.logos_brands || "").trim()}`,
          `TEXT_OCR: ${String(row?.text_ocr || "").trim()}`,
          `SCENE: ${String(row?.scene || "").trim()}`,
          `LAYOUT: ${String(row?.layout || "").trim()}`,
        ];
        const description = parts.join("\n").trim();
        return { pageNumber, description };
      })
      .filter(
        (item) =>
          allowed.has(item.pageNumber) &&
          item.pageNumber > 0 &&
          item.description.length > 20,
      );
  } catch {
    return [];
  }
}

/**
 * Extract a JSON array/object payload from model output.
 * @param {string} text
 * @returns {string}
 */
function extractJsonPayload(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return "";

  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return cleaned.slice(arrayStart, arrayEnd + 1);
  }

  const objStart = cleaned.indexOf("{");
  const objEnd = cleaned.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    return cleaned.slice(objStart, objEnd + 1);
  }

  return "";
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

  const regex =
    /^\s*PAGE\s+(\d+)\s*:?\s*([\s\S]*?)(?=^\s*PAGE\s+\d+\s*:?\s*|^\s*---\s*$|$)/gim;
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
 * Merge saved extracted-image context into vision page descriptions so
 * embeddings retain image-specific details even when chunking by page.
 * @param {object} db
 * @param {number} documentId
 * @param {Array<{pageNumber:number,description:string}>} visionPages
 * @returns {Array<{pageNumber:number,description:string}>}
 */
function mergeVisionDescriptionsWithImageContext(db, documentId, visionPages) {
  if (!Array.isArray(visionPages) || visionPages.length === 0) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT page_number, context_text
       FROM extracted_images
       WHERE document_id = ?
         AND page_number IS NOT NULL
         AND context_text IS NOT NULL
         AND TRIM(context_text) <> ''
       ORDER BY id ASC`,
    )
    .all(documentId);

  const contextByPage = new Map();
  for (const row of rows) {
    const pageNumber = Number(row.page_number || 0);
    const text = String(row.context_text || "").trim();
    if (!pageNumber || text.length === 0) continue;
    if (!contextByPage.has(pageNumber)) {
      contextByPage.set(pageNumber, []);
    }
    if (contextByPage.get(pageNumber).length < 2) {
      contextByPage.get(pageNumber).push(text.slice(0, 700));
    }
  }

  return visionPages.map((page) => {
    const extras = contextByPage.get(Number(page.pageNumber || 0));
    if (!extras || extras.length === 0) {
      return page;
    }

    return {
      ...page,
      description:
        `${String(page.description || "").trim()}\n\n` +
        `EXTRACTED_IMAGE_CONTEXT:\n${extras.join("\n")}`,
    };
  });
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
  db,
  pdfBuffer,
  numPages,
  documentId,
) {
  if (!GEMINI_VISION_ENABLED) return [];

  try {
    return await promiseWithTimeout(
      describeAllPagesWithGemini(db, pdfBuffer, numPages, documentId),
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
 * Persist detected embedded images as PNG files and metadata.
 * Uses pdfjs callback-based object resolution to correctly handle
 * FlateDecode, DCT, JPX and all other PDF image stream types.
 *
 * @param {object} db
 * @param {Buffer} pdfBuffer
 * @param {number} documentId
 * @returns {Promise<number>}
 */
async function saveDetectedEmbeddedImages(db, pdfBuffer, documentId) {
  db.prepare("DELETE FROM extracted_images WHERE document_id = ?").run(
    documentId,
  );

  if (!fs.existsSync(extractedImagesDir)) {
    fs.mkdirSync(extractedImagesDir, { recursive: true });
  }

  const canvasModule = await getCanvas();
  if (!canvasModule?.createCanvas) {
    console.warn("[images] canvas unavailable; skipping image extraction");
    return 0;
  }

  let savedCount = 0;

  // Primary: pdfjs callback-based extraction (handles ALL image types)
  try {
    savedCount = await extractImagesWithPdfjs(
      db,
      pdfBuffer,
      documentId,
      canvasModule,
    );
    console.log(`[images] pdfjs extracted ${savedCount} image(s)`);
  } catch (err) {
    console.warn(`[images] pdfjs extraction failed: ${err.message}`);
  }

  if (savedCount > 0) return savedCount;

  // Fallback: raw JPEG byte scan (legacy)
  const rawImages = findEmbeddedJpegs(pdfBuffer);
  if (rawImages.length === 0) return 0;

  if (!canvasModule?.loadImage) return 0;

  const insertImage = db.prepare(
    `INSERT INTO extracted_images (
      document_id, page_number, image_path, mime_type, width, height, file_size, source_type, context_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < rawImages.length; i++) {
    try {
      const loaded = await canvasModule.loadImage(rawImages[i].buffer);
      const width = Math.max(1, Math.round(loaded.width || 0));
      const height = Math.max(1, Math.round(loaded.height || 0));
      const canvas = canvasModule.createCanvas(width, height);
      canvas.getContext("2d").drawImage(loaded, 0, 0, width, height);
      const pngBuffer = canvas.toBuffer("image/png");
      const hash = createHash("sha1")
        .update(pngBuffer)
        .digest("hex")
        .slice(0, 12);
      const filename = `doc_${documentId}_embedded_${i + 1}_${hash}.png`;
      fs.writeFileSync(path.join(extractedImagesDir, filename), pngBuffer);
      insertImage.run(
        documentId,
        rawImages[i].estimatedPage || null,
        filename,
        "image/png",
        width,
        height,
        pngBuffer.length,
        "embedded",
        null,
      );
      savedCount += 1;
    } catch (err) {
      console.warn(`[images] Legacy image ${i + 1} failed: ${err.message}`);
    }
  }

  return savedCount;
}

/**
 * Extract images from PDF pages using pdfjs operator lists with callback-based
 * async object resolution — the correct API for resolving FlateDecode/DCT/JPX
 * image XObjects that are loaded asynchronously by the pdfjs render pipeline.
 *
 * Key insight: page.objs.get(id) throws "not resolved yet" when called
 * synchronously after getOperatorList(). The callback form
 * page.objs.get(id, callback) waits for the object to be ready.
 *
 * @param {object} db
 * @param {Buffer} pdfBuffer
 * @param {number} documentId
 * @param {object} canvasModule
 * @returns {Promise<number>}
 */
async function extractImagesWithPdfjs(db, pdfBuffer, documentId, canvasModule) {
  const pdfjsLib = await getPdfjs();
  const pdfDoc = await pdfjsLib.getDocument(
    buildPdfjsLoadOptions(new Uint8Array(pdfBuffer)),
  ).promise;

  const { createCanvas } = canvasModule;
  const insertImage = db.prepare(
    `INSERT INTO extracted_images (
      document_id, page_number, image_path, mime_type, width, height, file_size, source_type, context_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const MIN_DIMENSION = 50;
  const MIN_BYTES = 2048;
  const MAX_IMAGES_PER_DOC = 200;
  const OBJ_RESOLVE_TIMEOUT_MS = 10000;

  let totalSaved = 0;
  const seenHashes = new Set();

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    if (totalSaved >= MAX_IMAGES_PER_DOC) break;

    let page;
    try {
      page = await pdfDoc.getPage(pageNum);
    } catch (err) {
      console.warn(`[images] Could not load page ${pageNum}: ${err.message}`);
      continue;
    }

    try {
      const opList = await page.getOperatorList();
      const ops = pdfjsLib.OPS || {};

      const imageOpCodes = new Set(
        [
          ops.paintImageXObject,
          ops.paintInlineImageXObject,
          ops.paintImageMaskXObject,
        ].filter(Number.isInteger),
      );

      // Collect unique image object IDs from this page's operator list
      const imageObjIds = [];
      const seen = new Set();
      for (let i = 0; i < opList.fnArray.length; i++) {
        if (!imageOpCodes.has(opList.fnArray[i])) continue;
        const objId = opList.argsArray[i]?.[0];
        if (objId && !seen.has(objId)) {
          seen.add(objId);
          imageObjIds.push(objId);
        }
      }

      if (imageObjIds.length === 0) continue;

      // Resolve each image object using the callback API (async-safe)
      for (const objId of imageObjIds) {
        let imgData;
        try {
          imgData = await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`Timeout resolving ${objId}`)),
              OBJ_RESOLVE_TIMEOUT_MS,
            );
            try {
              page.objs.get(objId, (obj) => {
                clearTimeout(timer);
                resolve(obj);
              });
            } catch (e) {
              clearTimeout(timer);
              reject(e);
            }
          });
        } catch (err) {
          console.warn(`[images] Page ${pageNum} ${objId}: ${err.message}`);
          continue;
        }

        if (!imgData) continue;

        const width = Number(imgData.width || 0);
        const height = Number(imgData.height || 0);
        if (width < MIN_DIMENSION || height < MIN_DIMENSION) continue;

        // Convert raw pixel data to PNG via canvas
        let pngBuffer;
        try {
          const canvas = createCanvas(width, height);
          const ctx = canvas.getContext("2d");
          const dataArr = imgData.data;

          if (
            dataArr instanceof Uint8ClampedArray ||
            dataArr instanceof Uint8Array
          ) {
            const channels = dataArr.length / (width * height);
            let rgba;

            if (channels === 4) {
              rgba = new Uint8ClampedArray(dataArr);
            } else if (channels === 3) {
              rgba = new Uint8ClampedArray(width * height * 4);
              for (let p = 0; p < width * height; p++) {
                rgba[p * 4] = dataArr[p * 3];
                rgba[p * 4 + 1] = dataArr[p * 3 + 1];
                rgba[p * 4 + 2] = dataArr[p * 3 + 2];
                rgba[p * 4 + 3] = 255;
              }
            } else if (channels === 1) {
              rgba = new Uint8ClampedArray(width * height * 4);
              for (let p = 0; p < width * height; p++) {
                const v = dataArr[p];
                rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = v;
                rgba[p * 4 + 3] = 255;
              }
            } else {
              continue;
            }

            const id = ctx.createImageData(width, height);
            id.data.set(rgba);
            ctx.putImageData(id, 0, 0);
            pngBuffer = canvas.toBuffer("image/png");
          } else if (canvasModule.loadImage && dataArr) {
            // Encoded buffer (JPEG bytes etc.)
            const raw = Buffer.isBuffer(dataArr)
              ? dataArr
              : Buffer.from(dataArr);
            const loaded = await canvasModule.loadImage(raw);
            ctx.drawImage(loaded, 0, 0, width, height);
            pngBuffer = canvas.toBuffer("image/png");
          } else {
            continue;
          }
        } catch (err) {
          console.warn(
            `[images] Page ${pageNum} ${objId} render: ${err.message}`,
          );
          continue;
        }

        if (!pngBuffer || pngBuffer.length < MIN_BYTES) continue;

        const hash = createHash("sha1")
          .update(pngBuffer)
          .digest("hex")
          .slice(0, 12);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        const filename = `doc_${documentId}_p${pageNum}_${objId}_${hash}.png`;
        try {
          fs.writeFileSync(path.join(extractedImagesDir, filename), pngBuffer);
          insertImage.run(
            documentId,
            pageNum,
            filename,
            "image/png",
            width,
            height,
            pngBuffer.length,
            "embedded",
            null,
          );
          totalSaved += 1;
          console.log(`[images] Saved ${filename} (${width}x${height})`);
        } catch (err) {
          console.warn(`[images] Failed to save ${filename}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[images] Page ${pageNum} error: ${err.message}`);
    } finally {
      page.cleanup();
    }
  }

  return totalSaved;
}

function persistPageCaptureImage(
  db,
  documentId,
  pageNumber,
  pngBuffer,
  contextText,
) {
  if (!fs.existsSync(extractedImagesDir)) {
    fs.mkdirSync(extractedImagesDir, { recursive: true });
  }

  const hash = createHash("sha1").update(pngBuffer).digest("hex").slice(0, 12);
  const filename = `doc_${documentId}_page_${pageNumber}_${hash}.png`;
  const absolutePath = path.join(extractedImagesDir, filename);
  fs.writeFileSync(absolutePath, pngBuffer);

  const existing = db
    .prepare(
      `SELECT id, image_path FROM extracted_images
       WHERE document_id = ? AND page_number = ? AND source_type = 'page_capture'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(documentId, pageNumber);

  if (existing?.id) {
    if (existing.image_path) {
      const oldPath = path.join(extractedImagesDir, existing.image_path);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }
    db.prepare(
      `UPDATE extracted_images
       SET image_path = ?, mime_type = ?, width = ?, height = ?, file_size = ?, context_text = ?
       WHERE id = ?`,
    ).run(
      filename,
      "image/png",
      null,
      null,
      pngBuffer.length,
      String(contextText || "").slice(0, 4000) || null,
      existing.id,
    );
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO extracted_images (
        document_id, page_number, image_path, mime_type, width, height, file_size, source_type, context_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      documentId,
      pageNumber,
      filename,
      "image/png",
      null,
      null,
      pngBuffer.length,
      "page_capture",
      String(contextText || "").slice(0, 4000) || null,
    );

  return Number(info?.lastInsertRowid || 0);
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
async function generateAndStoreEmbeddings(
  db,
  documentId,
  savedChunks,
  onProgress,
) {
  if (savedChunks.length === 0) return;

  if (savedChunks.length > 50) {
    console.log(
      `[doc:${documentId}] Generating embeddings for ${savedChunks.length} chunks…`,
    );
  }

  const chunkTexts = savedChunks.map((c) => c.content);
  if (typeof onProgress === "function") {
    onProgress(0.15);
  }
  const embeddings = await generateEmbeddings(chunkTexts);
  if (typeof onProgress === "function") {
    onProgress(0.75);
  }

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
  if (typeof onProgress === "function") {
    onProgress(1);
  }
  console.log(
    `[doc:${documentId}] Stored ${vectors.length} embeddings in Pinecone`,
  );
}

/**
 * Generate and persist AI search metadata for document discovery.
 * @param {object} db
 * @param {number} documentId
 * @param {Array<{content:string}>} savedChunks
 */
async function updateDocumentSearchMetadata(db, documentId, savedChunks) {
  const doc = db
    .prepare("SELECT original_name FROM documents WHERE id = ?")
    .get(documentId);

  const fallbackTitle = deriveTitleFromFilename(
    doc?.original_name || "document",
  );
  const textSample = (savedChunks || [])
    .slice(0, 8)
    .map((chunk) => String(chunk.content || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 5000);

  if (!textSample) {
    db.prepare(
      "UPDATE documents SET ai_title_short = ?, ai_summary = ? WHERE id = ?",
    ).run(fallbackTitle, fallbackTitle, documentId);
    return;
  }

  const metadata = await generateSearchMetadataWithGemini(
    textSample,
    fallbackTitle,
  );

  db.prepare(
    "UPDATE documents SET ai_title_short = ?, ai_summary = ? WHERE id = ?",
  ).run(metadata.title, metadata.summary, documentId);
}

/**
 * Generate 1-5 word title and concise summary using Gemini with fallback.
 * @param {string} textSample
 * @param {string} fallbackTitle
 * @returns {Promise<{title:string, summary:string}>}
 */
async function generateSearchMetadataWithGemini(textSample, fallbackTitle) {
  const defaultMetadata = {
    title: clampWords(fallbackTitle, 5),
    summary: textSample.split(/\s+/).slice(0, 24).join(" "),
  };

  if (!GEMINI_API_KEY) {
    return defaultMetadata;
  }

  const prompt =
    "You are generating searchable metadata for a PDF document list. " +
    "Return ONLY valid JSON with keys title and summary. " +
    "title must be 1 to 5 words, no file extension. " +
    "summary must be one concise sentence under 20 words. " +
    "Do not use markdown fences.";

  const body = {
    contents: [
      {
        parts: [{ text: prompt }, { text: `Document excerpt:\n${textSample}` }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 256,
    },
  };

  const candidateModels = [
    GEMINI_TEXT_MODEL,
    ...GEMINI_TEXT_FALLBACK_MODELS.filter((m) => m !== GEMINI_TEXT_MODEL),
  ];

  for (let i = 0; i < candidateModels.length; i++) {
    const modelName = candidateModels[i];
    const url = `${GEMINI_API_BASE}/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const message =
          errBody?.error?.message || `Gemini HTTP ${response.status}`;
        if (
          i < candidateModels.length - 1 &&
          shouldTryAnotherVisionModel(response.status, message)
        ) {
          continue;
        }
        break;
      }

      const data = await response.json();
      const raw = extractGeminiResponseText(data);
      const jsonPayload = extractJsonPayload(raw);
      if (!jsonPayload) {
        continue;
      }

      const parsed = JSON.parse(jsonPayload);
      const title = clampWords(
        String(parsed?.title || fallbackTitle)
          .replace(/\.pdf$/i, "")
          .trim(),
        5,
      );
      const summary = String(parsed?.summary || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);

      return {
        title: title || defaultMetadata.title,
        summary: summary || defaultMetadata.summary,
      };
    } catch {
      // Try next fallback model.
    }
  }

  return defaultMetadata;
}

/**
 * Derive a compact title from original filename.
 * @param {string} originalName
 * @returns {string}
 */
function deriveTitleFromFilename(originalName) {
  return clampWords(
    String(originalName || "document")
      .replace(/\.pdf$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    5,
  );
}

/**
 * Keep only first N words.
 * @param {string} text
 * @param {number} maxWords
 * @returns {string}
 */
function clampWords(text, maxWords) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .slice(0, maxWords)
    .join(" ");
}

/**
 * Update processing telemetry for a document.
 * @param {object} db
 * @param {number} documentId
 * @param {object} patch
 */
function setDocumentProgress(db, documentId, patch) {
  const updates = [];
  const params = [];

  if (typeof patch.status === "string") {
    updates.push("status = ?");
    params.push(patch.status);
  }
  if (typeof patch.processingStage === "string") {
    updates.push("processing_stage = ?");
    params.push(patch.processingStage);
  }
  if (typeof patch.statusMessage === "string") {
    updates.push("status_message = ?");
    params.push(patch.statusMessage);
  }
  if (typeof patch.progressPercent === "number") {
    const bounded = Math.max(0, Math.min(100, patch.progressPercent));
    updates.push("progress_percent = ?");
    params.push(Math.round(bounded * 100) / 100);
  }
  if (typeof patch.chunksTotal === "number") {
    updates.push("chunks_total = ?");
    params.push(Math.max(0, Math.trunc(patch.chunksTotal)));
  }
  if (typeof patch.chunksProcessed === "number") {
    updates.push("chunks_processed = ?");
    params.push(Math.max(0, Math.trunc(patch.chunksProcessed)));
  }
  if (typeof patch.extractedImageCount === "number") {
    updates.push("extracted_image_count = ?");
    params.push(Math.max(0, Math.trunc(patch.extractedImageCount)));
  }

  if (updates.length === 0) return;
  params.push(documentId);
  db.prepare(`UPDATE documents SET ${updates.join(", ")} WHERE id = ?`).run(
    ...params,
  );
}
