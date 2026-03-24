/**
 * Pinecone vector store manager
 * Handles vector storage, retrieval, and deletion
 */

import { Pinecone } from "@pinecone-database/pinecone";

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || "pdf-qa-bot";
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST;
const PINECONE_CLOUD = process.env.PINECONE_CLOUD || "aws";
const PINECONE_REGION = process.env.PINECONE_REGION || "us-east-1";
const EMBEDDING_DIMENSIONS = 3072;
const INDEX_METRIC = "cosine";
const INDEX_READY_MAX_WAIT_MS = 120000;
const INDEX_READY_POLL_MS = 2000;
const MAX_BATCH_SIZE = 100;
const CONTENT_PREVIEW_LENGTH = 500;

let pineconeClient = null;
let pineconeIndex = null;
let pineconeDisabledReason = null;

/**
 * Initialize Pinecone client
 * @returns {Promise<Pinecone|null>} Pinecone client or null if not configured
 */
export async function initPinecone() {
  if (!PINECONE_API_KEY) {
    pineconeDisabledReason =
      "PINECONE_API_KEY not configured. Vector search disabled.";
    console.log(pineconeDisabledReason);
    return null;
  }

  if (pineconeClient) {
    return pineconeClient;
  }

  try {
    pineconeClient = new Pinecone({
      apiKey: PINECONE_API_KEY,
    });

    // Validate index and auto-create it if missing.
    await ensureIndexExists(pineconeClient, PINECONE_INDEX_NAME);

    pineconeIndex = PINECONE_INDEX_HOST
      ? pineconeClient.index(PINECONE_INDEX_NAME, PINECONE_INDEX_HOST)
      : pineconeClient.index(PINECONE_INDEX_NAME);
    pineconeDisabledReason = null;

    console.log(`Pinecone initialized with index: ${PINECONE_INDEX_NAME}`);
    return pineconeClient;
  } catch (err) {
    if (isIndexNotFoundError(err)) {
      pineconeDisabledReason =
        `Pinecone index "${PINECONE_INDEX_NAME}" was not found. ` +
        "Automatic creation failed. Check PINECONE_CLOUD/PINECONE_REGION or create the index manually.";
      console.error(pineconeDisabledReason);
    } else {
      pineconeDisabledReason = `Failed to initialize Pinecone: ${err.message}`;
      console.error(pineconeDisabledReason);
    }
    pineconeClient = null;
    pineconeIndex = null;
    return null;
  }
}

/**
 * Ensure a Pinecone index exists. If missing, create it and wait until ready.
 * @param {Pinecone} client
 * @param {string} indexName
 */
async function ensureIndexExists(client, indexName) {
  try {
    await client.describeIndex(indexName);
    return;
  } catch (err) {
    if (!isIndexNotFoundError(err)) {
      throw err;
    }
  }

  console.warn(
    `Pinecone index "${indexName}" not found. Creating index (${EMBEDDING_DIMENSIONS} dims, ${INDEX_METRIC}, ${PINECONE_CLOUD}/${PINECONE_REGION})...`,
  );

  await client.createIndex({
    name: indexName,
    dimension: EMBEDDING_DIMENSIONS,
    metric: INDEX_METRIC,
    spec: {
      serverless: {
        cloud: PINECONE_CLOUD,
        region: PINECONE_REGION,
      },
    },
  });

  await waitForIndexReady(client, indexName);
  console.log(`Pinecone index "${indexName}" created and ready.`);
}

/**
 * Poll index status until it becomes ready.
 * @param {Pinecone} client
 * @param {string} indexName
 */
async function waitForIndexReady(client, indexName) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < INDEX_READY_MAX_WAIT_MS) {
    const description = await client.describeIndex(indexName);
    if (description?.status?.ready) {
      return;
    }
    await sleep(INDEX_READY_POLL_MS);
  }

  throw new Error(
    `Timed out waiting for Pinecone index "${indexName}" to become ready after ${INDEX_READY_MAX_WAIT_MS}ms`,
  );
}

/**
 * Pinecone SDK errors do not always expose status code consistently.
 * @param {Error & {status?: number, code?: number|string}} err
 * @returns {boolean}
 */
function isIndexNotFoundError(err) {
  const message = String(err?.message || "").toLowerCase();
  return (
    err?.status === 404 ||
    err?.code === 404 ||
    message.includes("http status 404") ||
    message.includes("returned http status 404") ||
    message.includes("not found")
  );
}

/**
 * Sleep utility for polling loops.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Store chunk embeddings in Pinecone
 * @param {Array<{id: string, embedding: number[], metadata: object}>} vectors
 * @returns {Promise<void>}
 */
export async function upsertVectors(vectors) {
  if (!pineconeIndex) {
    await initPinecone();
  }

  if (!pineconeIndex) {
    throw new Error(pineconeDisabledReason || "Pinecone not configured");
  }

  if (!vectors || vectors.length === 0) {
    return;
  }

  // Process in batches
  for (let i = 0; i < vectors.length; i += MAX_BATCH_SIZE) {
    const batch = vectors.slice(i, i + MAX_BATCH_SIZE);

    // Format vectors for Pinecone
    const formattedVectors = batch.map((v) => ({
      id: v.id,
      values: v.embedding,
      metadata: {
        document_id: toSafeInt(v.metadata.document_id),
        chunk_id: toSafeInt(v.metadata.chunk_id),
        page_number: toSafeInt(v.metadata.page_number),
        content_preview:
          v.metadata.content_preview?.slice(0, CONTENT_PREVIEW_LENGTH) || "",
      },
    }));

    try {
      await pineconeIndex.upsert(formattedVectors);
    } catch (err) {
      console.error(
        `Failed to upsert batch ${i / MAX_BATCH_SIZE + 1}:`,
        err.message,
      );
      throw err;
    }
  }
}

/**
 * Search for similar vectors
 * @param {number[]} queryEmbedding - Query vector
 * @param {number} topK - Number of results
 * @param {object} filter - Metadata filter (e.g., {document_id: 123})
 * @returns {Promise<Array<{id: string, score: number, metadata: object}>>}
 */
export async function searchVectors(queryEmbedding, topK, filter = {}) {
  if (!pineconeIndex) {
    await initPinecone();
  }

  if (!pineconeIndex) {
    throw new Error(pineconeDisabledReason || "Pinecone not configured");
  }

  try {
    const queryRequest = {
      vector: queryEmbedding,
      topK: topK,
      includeMetadata: true,
    };

    if (Object.keys(filter).length > 0) {
      queryRequest.filter = filter;
    }

    const response = await pineconeIndex.query(queryRequest);

    return response.matches.map((match) => ({
      id: match.id,
      score: match.score,
      metadata: match.metadata,
    }));
  } catch (err) {
    console.error("Pinecone search failed:", err.message);
    throw err;
  }
}

/**
 * Delete vectors by IDs
 * @param {string[]} ids - Vector IDs to delete
 * @returns {Promise<void>}
 */
export async function deleteVectors(ids) {
  if (!pineconeIndex) {
    await initPinecone();
  }

  if (!pineconeIndex) {
    throw new Error(pineconeDisabledReason || "Pinecone not configured");
  }

  if (!ids || ids.length === 0) {
    return;
  }

  try {
    await pineconeIndex.deleteMany(ids);
  } catch (err) {
    console.error("Failed to delete vectors:", err.message);
    throw err;
  }
}

/**
 * Delete all vectors for a document
 * @param {number} documentId
 * @returns {Promise<void>}
 */
export async function deleteDocumentVectors(documentId) {
  if (!pineconeIndex) {
    await initPinecone();
  }

  if (!pineconeIndex) {
    throw new Error(pineconeDisabledReason || "Pinecone not configured");
  }

  try {
    // Pinecone deleteMany expects the metadata filter object directly, not wrapped in { filter: ... }.
    const normalizedDocumentId = toSafeInt(documentId);
    await pineconeIndex.deleteMany({
      document_id: { $eq: normalizedDocumentId },
    });
  } catch (err) {
    console.error(
      `Failed to delete vectors for document ${documentId}:`,
      err.message,
    );
    throw err;
  }
}

/**
 * Normalize metadata numeric fields (SQLite can surface numbers as floats like 9.0).
 * @param {unknown} value
 * @returns {number}
 */
function toSafeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.trunc(parsed);
}

/**
 * Check if Pinecone is configured and connected
 * @returns {Promise<{configured: boolean, connected: boolean}>}
 */
export async function checkStatus() {
  const configured = !!PINECONE_API_KEY;

  if (!configured) {
    return {
      configured: false,
      connected: false,
      reason: pineconeDisabledReason,
    };
  }

  try {
    await initPinecone();

    // Try a simple operation to verify connection
    if (pineconeIndex) {
      await pineconeIndex.describeIndexStats();
      return { configured: true, connected: true, reason: null };
    }

    return {
      configured: true,
      connected: false,
      reason: pineconeDisabledReason,
    };
  } catch (err) {
    console.error("Pinecone connection check failed:", err.message);
    return {
      configured: true,
      connected: false,
      reason: pineconeDisabledReason || err.message,
    };
  }
}
