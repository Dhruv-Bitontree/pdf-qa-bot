/**
 * Text chunking service with sentence-boundary awareness.
 * Splits text into overlapping chunks while tracking page positions.
 */

const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_OVERLAP = 100;

/**
 * Split text into chunks with overlap, respecting sentence boundaries.
 * @param {string} text - The text to chunk
 * @param {number} pageNumber - Page number this text came from
 * @param {object} options
 * @returns {{ content: string, page_number: number, start_offset: number, end_offset: number }[]}
 */
export function chunkText(text, pageNumber, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap || DEFAULT_OVERLAP;

  if (!text || text.trim().length === 0) return [];

  // If text is shorter than chunk size, return as single chunk
  if (text.trim().length <= chunkSize) {
    return [{
      content: text.trim(),
      page_number: pageNumber,
      start_offset: 0,
      end_offset: text.length,
    }];
  }

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    // Try to break at a sentence boundary
    if (end < text.length) {
      const slice = text.slice(start, end);
      const lastSentenceEnd = findLastSentenceEnd(slice);
      if (lastSentenceEnd > chunkSize * 0.3) {
        end = start + lastSentenceEnd;
      }
    }

    const content = text.slice(start, end).trim();
    if (content.length > 0) {
      chunks.push({
        content,
        page_number: pageNumber,
        start_offset: start,
        end_offset: end,
      });
    }

    // If we've reached the end, stop
    if (end >= text.length) break;

    // Move start forward, accounting for overlap
    const advance = end - start - overlap;
    start += Math.max(advance, 1);
  }

  return chunks;
}

/**
 * Find the last sentence-ending position in a string.
 */
function findLastSentenceEnd(text) {
  const sentenceEnders = /[.!?]\s/g;
  let lastIndex = -1;
  let match;
  while ((match = sentenceEnders.exec(text)) !== null) {
    lastIndex = match.index + match[0].length;
  }
  return lastIndex;
}

/**
 * Chunk an entire document's text organized by pages.
 * @param {{ pageNumber: number, text: string }[]} pages
 * @returns {{ content: string, page_number: number, start_offset: number, end_offset: number, chunk_index: number }[]}
 */
export function chunkDocument(pages, options = {}) {
  let chunkIndex = 0;
  const allChunks = [];

  for (const page of pages) {
    const chunks = chunkText(page.text, page.pageNumber, options);
    for (const chunk of chunks) {
      allChunks.push({ ...chunk, chunk_index: chunkIndex++ });
    }
  }

  return allChunks;
}
