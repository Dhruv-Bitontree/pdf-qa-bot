/**
 * BM25 search index backed by SQLite.
 * Provides full-text retrieval without external API dependencies.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if',
  'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such',
  'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this',
  'to', 'was', 'will', 'with', 'from', 'has', 'have', 'had', 'been',
  'would', 'could', 'should', 'do', 'does', 'did', 'can', 'may',
  'about', 'above', 'after', 'again', 'all', 'also', 'am', 'any',
  'because', 'before', 'between', 'both', 'each', 'few', 'get',
  'got', 'he', 'her', 'here', 'him', 'his', 'how', 'i', 'its',
  'just', 'know', 'like', 'make', 'me', 'might', 'more', 'most',
  'much', 'my', 'need', 'new', 'now', 'only', 'other', 'our',
  'out', 'over', 'own', 'say', 'she', 'so', 'some', 'still',
  'take', 'than', 'them', 'too', 'up', 'us', 'very', 'want',
  'way', 'we', 'well', 'what', 'when', 'which', 'who', 'why',
  'you', 'your',
]);

// BM25 parameters
const K1 = 1.5;
const B = 0.75;

/**
 * Tokenize text into searchable terms.
 */
export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Build BM25 index for a document's chunks.
 * @param {object} db - SQLite database
 * @param {number} documentId
 * @param {{ id: number, content: string }[]} chunks - Chunks with IDs from DB
 */
export function buildIndex(db, documentId, chunks) {
  const insertTerm = db.prepare('INSERT INTO term_index (term, chunk_id, tf) VALUES (?, ?, ?)');

  const buildAll = db.transaction(() => {
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.content);
      if (tokens.length === 0) continue;

      // Compute term frequencies
      const termCounts = {};
      for (const token of tokens) {
        termCounts[token] = (termCounts[token] || 0) + 1;
      }

      // Normalize TF by total token count
      for (const [term, count] of Object.entries(termCounts)) {
        insertTerm.run(term, chunk.id, count / tokens.length);
      }
    }
  });

  buildAll();
}

/**
 * Search for chunks matching a query using BM25 scoring.
 * @param {object} db
 * @param {number} documentId
 * @param {string} query
 * @param {number} topK
 * @returns {{ chunk_id: number, score: number, content: string, page_number: number, start_offset: number, end_offset: number }[]}
 */
export function search(db, documentId, query, topK = 5) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Get all chunk IDs and lengths for this document
  const chunks = db
    .prepare('SELECT id, content, page_number, start_offset, end_offset FROM chunks WHERE document_id = ?')
    .all(documentId);

  if (chunks.length === 0) return [];

  const N = chunks.length;
  const avgDl = chunks.reduce((sum, c) => sum + tokenize(c.content).length, 0) / N;

  // Pre-compute doc lengths
  const docLengths = {};
  for (const c of chunks) {
    docLengths[c.id] = tokenize(c.content).length;
  }

  // Score each chunk
  const scores = {};
  const chunkMap = {};
  for (const c of chunks) {
    scores[c.id] = 0;
    chunkMap[c.id] = c;
  }

  for (const term of queryTokens) {
    // Get term's document frequency
    const termChunks = db
      .prepare(
        `SELECT ti.chunk_id, ti.tf FROM term_index ti
         JOIN chunks c ON ti.chunk_id = c.id
         WHERE ti.term = ? AND c.document_id = ?`
      )
      .all(term, documentId);

    const df = termChunks.length;
    if (df === 0) continue;

    // IDF component
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

    for (const { chunk_id, tf } of termChunks) {
      const dl = docLengths[chunk_id] || 1;
      // BM25 score for this term in this chunk
      const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgDl)));
      scores[chunk_id] += idf * tfNorm;
    }
  }

  // Sort by score and return top-K
  return Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([chunkId, score]) => {
      const c = chunkMap[Number(chunkId)];
      return {
        chunk_id: c.id,
        score,
        content: c.content,
        page_number: c.page_number,
        start_offset: c.start_offset,
        end_offset: c.end_offset,
      };
    });
}
