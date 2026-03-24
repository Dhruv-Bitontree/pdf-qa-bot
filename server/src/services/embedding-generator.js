/**
 * Embedding generation service using OpenRouter API
 * Model: openai/text-embedding-3-large (3072 dimensions)
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMBEDDING_MODEL = 'openai/text-embedding-3-large';
const MAX_BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;

/**
 * Generate embeddings for multiple texts in batches
 * @param {string[]} texts - Array of text strings to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 * @throws {Error} If API call fails after retries
 */
export async function generateEmbeddings(texts) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  if (!texts || texts.length === 0) {
    return [];
  }

  const allEmbeddings = [];

  // Process in batches of MAX_BATCH_SIZE
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const batchEmbeddings = await generateEmbeddingsBatch(batch);
    allEmbeddings.push(...batchEmbeddings);
  }

  return allEmbeddings;
}

/**
 * Generate embedding for a single text
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
export async function generateEmbedding(text) {
  const embeddings = await generateEmbeddings([text]);
  return embeddings[0];
}

/**
 * Generate embeddings for a batch of texts with retry logic
 * @param {string[]} texts - Batch of texts (max 100)
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function generateEmbeddingsBatch(texts) {
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await callOpenRouterAPI(texts);
    } catch (err) {
      lastError = err;

      // Don't retry on authentication errors
      if (err.status === 401 || err.status === 403) {
        throw new Error(`OpenRouter authentication failed: ${err.message}`);
      }

      // Retry on rate limits and network errors
      if (err.status === 429 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
        const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
        console.log(`Retry attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`);
        await sleep(delay);
        continue;
      }

      // Don't retry on other errors
      throw err;
    }
  }

  throw new Error(`Max retries (${MAX_RETRIES}) exceeded: ${lastError.message}`);
}

/**
 * Call OpenRouter API to generate embeddings
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function callOpenRouterAPI(texts) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // OpenRouter uses a different format for embeddings
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/pdf-qa-bot',
        'X-Title': 'PDF Q&A Bot'
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const err = new Error(error.error?.message || `API request failed with status ${response.status}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    
    // Extract embeddings from response
    const embeddings = data.data.map(item => item.embedding);

    // Validate dimensions
    if (embeddings.length > 0 && embeddings[0].length !== 3072) {
      throw new Error(`Invalid embedding dimensions: expected 3072, got ${embeddings[0].length}`);
    }

    return embeddings;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Request timeout');
      timeoutErr.code = 'ETIMEDOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
