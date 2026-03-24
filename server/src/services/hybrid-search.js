/**
 * Hybrid search combining BM25 and Pinecone vector search.
 * Uses Reciprocal Rank Fusion (RRF) to merge results.
 *
 * Improvements:
 * - MIN_SCORE_THRESHOLD filters out weakly matching chunks so irrelevant
 *   pages never appear as sources.
 * - MAX_SOURCES caps the number of pages returned to the RAG layer.
 */

import { search as bm25Search } from "./search-index.js";
import { searchVectors, checkStatus } from "./vector-store.js";
import { generateEmbedding } from "./embedding-generator.js";

const RRF_K = 60; // Standard RRF constant

/**
 * Minimum normalised score [0-1] a chunk must reach to be included in
 * results.  Chunks below this threshold are silently dropped so that
 * weakly-matching pages never surface as source citations.
 * Tune via env var SEARCH_SCORE_THRESHOLD (default 0.25).
 */
const MIN_SCORE_THRESHOLD = parseFloat(
  process.env.SEARCH_SCORE_THRESHOLD ?? "0.25",
);

/**
 * Maximum number of distinct source chunks returned to the RAG layer.
 * Keeps citations focused and prevents page-number sprawl.
 * Tune via env var SEARCH_MAX_SOURCES (default 4).
 */
const MAX_SOURCES = parseInt(process.env.SEARCH_MAX_SOURCES ?? "4", 10);

/**
 * Perform hybrid search combining BM25 and Pinecone.
 *
 * @param {object} db - Database instance
 * @param {number} documentId - Document to search
 * @param {string} query - Search query
 * @param {number} topK - Candidate pool size before threshold filtering
 * @param {string} mode - 'bm25' | 'pinecone' | 'hybrid'
 * @returns {Promise<Array<{chunk_id: number, score: number, content: string, page_number: number}>>}
 */
export async function hybridSearch(
  db,
  documentId,
  query,
  topK = 8,
  mode = "hybrid",
) {
  // Validate mode
  if (!["bm25", "pinecone", "hybrid"].includes(mode)) {
    console.warn(`Invalid search mode: ${mode}, falling back to hybrid`);
    mode = "hybrid";
  }

  // BM25-only mode
  if (mode === "bm25") {
    const results = bm25Search(db, documentId, query, topK);
    return applyThresholdAndCap(normalizeScores(results));
  }

  // Pinecone or hybrid mode
  try {
    const status = await checkStatus();

    if (!status.connected) {
      if (mode === "pinecone") {
        console.warn("Pinecone not available, falling back to BM25");
      }
      const results = bm25Search(db, documentId, query, topK);
      return applyThresholdAndCap(normalizeScores(results));
    }

    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);

    // Search Pinecone
    const pineconeResults = await searchVectors(queryEmbedding, topK, {
      document_id: documentId,
    });

    // Convert Pinecone results to standard format
    const pineconeFormatted = pineconeResults.map((r) => {
      const chunk = db
        .prepare(
          "SELECT content, page_number, start_offset, end_offset FROM chunks WHERE id = ?",
        )
        .get(r.metadata.chunk_id);

      return {
        chunk_id: r.metadata.chunk_id,
        score: r.score,
        content: chunk?.content || r.metadata.content_preview,
        page_number: r.metadata.page_number,
        start_offset: chunk?.start_offset,
        end_offset: chunk?.end_offset,
      };
    });

    // Pinecone-only mode
    if (mode === "pinecone") {
      return applyThresholdAndCap(normalizeScores(pineconeFormatted));
    }

    // Hybrid mode: merge BM25 and Pinecone via RRF
    const bm25Results = bm25Search(db, documentId, query, topK);
    const merged = reciprocalRankFusion(
      [bm25Results, pineconeFormatted],
      RRF_K,
    );

    // Hydrate merged results with full chunk data
    const finalResults = merged.slice(0, topK).map((r) => {
      const chunk = db
        .prepare(
          "SELECT content, page_number, start_offset, end_offset FROM chunks WHERE id = ?",
        )
        .get(r.id);

      return {
        chunk_id: r.id,
        score: r.score,
        content: chunk.content,
        page_number: chunk.page_number,
        start_offset: chunk.start_offset,
        end_offset: chunk.end_offset,
      };
    });

    return applyThresholdAndCap(normalizeScores(finalResults));
  } catch (err) {
    console.error("Hybrid search error:", err.message);

    // Fall back to BM25 on any error
    if (mode !== "bm25") {
      console.warn("Falling back to BM25 search");
      const results = bm25Search(db, documentId, query, topK);
      return applyThresholdAndCap(normalizeScores(results));
    }

    throw err;
  }
}

/**
 * Reciprocal Rank Fusion algorithm.
 * Merges multiple ranked result lists into a single ranked list.
 *
 * @param {Array<Array<{chunk_id: number, score: number}>>} rankedLists
 * @param {number} k - RRF constant (default 60)
 * @returns {Array<{id: number, score: number}>}
 */
export function reciprocalRankFusion(rankedLists, k = 60) {
  const rrfScores = {};

  for (const rankedList of rankedLists) {
    rankedList.forEach((item, index) => {
      const id = item.chunk_id ?? item.id;
      const rank = index + 1;
      const rrfScore = 1 / (k + rank);

      rrfScores[id] = (rrfScores[id] ?? 0) + rrfScore;
    });
  }

  return Object.entries(rrfScores)
    .map(([id, score]) => ({ id: Number(id), score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Normalize scores to [0, 1] range relative to the highest scorer.
 *
 * @param {Array<{score: number}>} results
 * @returns {Array}
 */
function normalizeScores(results) {
  if (results.length === 0) return results;

  const maxScore = Math.max(...results.map((r) => r.score));
  if (maxScore === 0) return results;

  return results.map((r) => ({ ...r, score: r.score / maxScore }));
}

/**
 * Drop results below MIN_SCORE_THRESHOLD and cap at MAX_SOURCES.
 * This is the key fix that prevents irrelevant pages appearing as citations.
 *
 * @param {Array<{score: number}>} results - Normalised results
 * @returns {Array}
 */
function applyThresholdAndCap(results) {
  return results
    .filter((r) => r.score >= MIN_SCORE_THRESHOLD)
    .slice(0, MAX_SOURCES);
}
