/**
 * PDF processing pipeline:
 * 1. Extract text per page
 * 2. Extract embedded images and OCR them
 * 3. Chunk all text
 * 4. Build BM25 search index
 */

import fs from 'fs';
import pdfParse from 'pdf-parse';
import { chunkDocument } from './chunker.js';
import { buildIndex } from './search-index.js';
import { extractTextFromImage } from './ocr.js';

/**
 * Process a PDF document: extract text, OCR images, chunk, and index.
 * @param {object} db - SQLite database
 * @param {number} documentId
 * @param {string} filePath - Path to PDF file on disk
 */
export async function processDocument(db, documentId, filePath) {
  try {
    const dataBuffer = fs.readFileSync(filePath);

    // Extract text using pdf-parse
    const pdfData = await pdfParse(dataBuffer);

    // Split into pages (pdf-parse gives us numpages and text)
    // We'll use a heuristic: split by form-feed or estimate pages
    const pages = splitTextIntoPages(pdfData.text, pdfData.numpages);

    // Update page count
    db.prepare('UPDATE documents SET page_count = ? WHERE id = ?').run(pdfData.numpages, documentId);

    // Try to extract and OCR images from the PDF
    const ocrPages = await extractAndOcrImages(dataBuffer, pdfData.numpages);

    // Combine text pages with OCR results
    const allPages = [...pages];
    for (const ocrPage of ocrPages) {
      if (ocrPage.text.trim()) {
        allPages.push(ocrPage);
      }
    }

    // Chunk the document
    const chunks = chunkDocument(allPages);

    if (chunks.length === 0) {
      db.prepare("UPDATE documents SET status = 'ready' WHERE id = ?").run(documentId);
      return;
    }

    // Insert chunks into database
    const insertChunk = db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, content, page_number, start_offset, end_offset, chunk_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const insertAll = db.transaction(() => {
      for (const chunk of chunks) {
        insertChunk.run(
          documentId,
          chunk.chunk_index,
          chunk.content,
          chunk.page_number,
          chunk.start_offset,
          chunk.end_offset,
          'text'
        );
      }
    });
    insertAll();

    // Get chunks with their IDs for indexing
    const savedChunks = db
      .prepare('SELECT id, content FROM chunks WHERE document_id = ?')
      .all(documentId);

    // Build search index
    buildIndex(db, documentId, savedChunks);

    // Mark as ready
    db.prepare("UPDATE documents SET status = 'ready' WHERE id = ?").run(documentId);

    console.log(
      `Document ${documentId} processed: ${pages.length} pages, ${chunks.length} chunks`
    );
  } catch (err) {
    console.error(`Error processing document ${documentId}:`, err);
    db.prepare("UPDATE documents SET status = 'error' WHERE id = ?").run(documentId);
    throw err;
  }
}

/**
 * Split combined PDF text into pages.
 * pdf-parse returns all text concatenated; we use form-feeds or distribute evenly.
 */
function splitTextIntoPages(text, numPages) {
  // Try splitting by form-feed characters (common in PDF text extraction)
  const ffParts = text.split('\f').filter((p) => p.trim().length > 0);

  if (ffParts.length >= numPages * 0.5) {
    return ffParts.map((t, i) => ({ pageNumber: i + 1, text: t.trim() }));
  }

  // Fallback: distribute text evenly across pages
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
 * Attempt to extract images from PDF and run OCR on them.
 * Uses a simple approach - tries to find image-like data in the buffer.
 */
async function extractAndOcrImages(pdfBuffer, numPages) {
  const ocrPages = [];

  try {
    // Look for JPEG markers in the PDF buffer
    const images = findEmbeddedImages(pdfBuffer);

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
        // Skip failed OCR
      }
    }
  } catch {
    // OCR extraction is best-effort
  }

  return ocrPages;
}

/**
 * Find JPEG images embedded in a PDF buffer.
 */
function findEmbeddedImages(buffer) {
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

    // Only consider reasonable image sizes (1KB - 5MB)
    if (imgSize > 1024 && imgSize < 5 * 1024 * 1024) {
      images.push({
        buffer: buffer.slice(startIdx, imgEnd),
        estimatedPage: 1,
      });
    }

    pos = imgEnd;

    // Limit to 10 images to avoid long processing
    if (images.length >= 10) break;
  }

  return images;
}
