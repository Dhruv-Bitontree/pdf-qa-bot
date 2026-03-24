/**
 * RAG (Retrieval Augmented Generation) service.
 * Retrieves relevant chunks via BM25 and generates answers.
 *
 * Two modes:
 * - Extractive (default): Returns the most relevant passages directly
 * - Generative (optional): Uses an LLM to synthesize an answer (requires API key)
 */

import { search } from './search-index.js';

/**
 * Generate an answer for a user message using RAG.
 * @param {object} db
 * @param {number} conversationId
 * @param {number} documentId
 * @param {string} userMessage
 * @returns {{ userMessage: object, assistantMessage: object }}
 */
export async function generateAnswer(db, conversationId, documentId, userMessage) {
  // Save user message
  const insertMsg = db.prepare(
    'INSERT INTO messages (conversation_id, role, content, sources) VALUES (?, ?, ?, ?)'
  );
  insertMsg.run(conversationId, 'user', userMessage, null);

  const savedUserMsg = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? AND role = ? ORDER BY id DESC LIMIT 1')
    .get(conversationId, 'user');

  // Search for relevant chunks
  const results = search(db, documentId, userMessage, 5);

  let answerContent;
  let sources;

  if (results.length === 0) {
    answerContent =
      "I couldn't find any relevant information in the document for your question. Please try rephrasing or asking about a different topic covered in the PDF.";
    sources = null;
  } else {
    // Build source citations
    sources = results.map((r, i) => ({
      chunk_id: r.chunk_id,
      page_number: r.page_number,
      start_offset: r.start_offset,
      end_offset: r.end_offset,
      snippet: r.content.slice(0, 200),
      relevance_score: Math.round(r.score * 100) / 100,
    }));

    // Check if generative mode is available
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

    if (apiKey) {
      answerContent = await generateWithLLM(userMessage, results, apiKey);
    } else {
      answerContent = buildExtractiveAnswer(userMessage, results);
    }
  }

  // Save assistant message
  insertMsg.run(conversationId, 'assistant', answerContent, sources ? JSON.stringify(sources) : null);

  const savedAssistantMsg = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? AND role = ? ORDER BY id DESC LIMIT 1')
    .get(conversationId, 'assistant');

  return {
    userMessage: savedUserMsg,
    assistantMessage: {
      ...savedAssistantMsg,
      sources: sources || [],
    },
  };
}

/**
 * Build an extractive answer from retrieved chunks.
 */
function buildExtractiveAnswer(question, results) {
  const passages = results
    .map((r, i) => {
      const pageRef = `**[Page ${r.page_number}]**`;
      return `${pageRef}\n> ${r.content.trim()}`;
    })
    .join('\n\n---\n\n');

  return `Based on the document, here are the most relevant passages for your question:\n\n${passages}\n\n*${results.length} relevant section${results.length !== 1 ? 's' : ''} found. Click on page references to navigate to the source.*`;
}

/**
 * Generate a synthesized answer using an LLM (optional).
 */
async function generateWithLLM(question, results, apiKey) {
  const context = results
    .map((r, i) => `[Source ${i + 1}, Page ${r.page_number}]: ${r.content}`)
    .join('\n\n');

  const prompt = `Based on the following document excerpts, answer the user's question. Cite specific sources using [Page X] references.

Context from document:
${context}

Question: ${question}

Answer:`;

  try {
    // Try OpenAI-compatible API
    if (process.env.OPENAI_API_KEY) {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a helpful document Q&A assistant. Answer questions based only on the provided document context. Always cite page numbers.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1000,
        }),
      });
      const data = await response.json();
      if (data.choices?.[0]?.message?.content) {
        return data.choices[0].message.content;
      }
    }
  } catch (err) {
    console.error('LLM generation failed, falling back to extractive:', err.message);
  }

  // Fallback to extractive
  return buildExtractiveAnswer(question, results);
}
