/**
 * RAG (Retrieval Augmented Generation) service.
 *
 * Improvements over v1:
 * - Sources are filtered by MIN_RELEVANCE_SCORE and capped at MAX_CITATIONS
 *   so only genuinely relevant pages are cited.
 * - Visual-query detection: if the question asks about images, logos, diagrams
 *   etc. the search is widened to include vision chunks explicitly, and the
 *   Gemini prompt is told to draw on visual descriptions.
 * - The Gemini prompt is stricter: it MUST only cite the exact pages provided
 *   and is instructed not to hallucinate page numbers.
 * - dedupeSourcesByPage now returns at most MAX_CITATIONS entries.
 */

import { hybridSearch } from "./hybrid-search.js";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";
const GEMINI_FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash,gemini-1.5-flash"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * After deduplication, keep at most this many page citations.
 * Prevents answer bloat and irrelevant page references.
 * Tune via MAX_CITATIONS env var.
 */
const MAX_CITATIONS = parseInt(process.env.MAX_CITATIONS ?? "3", 10);

/**
 * Minimum relevance score [0-1] a chunk must have to be included as a source.
 * Chunks below this are already filtered in hybrid-search, but we guard here
 * too so extractive answers and citations remain tight.
 */
const MIN_RELEVANCE_SCORE = parseFloat(
  process.env.MIN_RELEVANCE_SCORE ?? "0.25",
);

/**
 * Keywords that indicate the user is asking about visual content.
 * When detected, we widen the search to ensure vision chunks are retrieved.
 */
const VISUAL_KEYWORDS = [
  "logo",
  "image",
  "picture",
  "photo",
  "photograph",
  "figure",
  "diagram",
  "chart",
  "graph",
  "illustration",
  "icon",
  "symbol",
  "color",
  "colour",
  "design",
  "layout",
  "screenshot",
  "banner",
  "drawing",
  "sketch",
  "table",
  "map",
  "infographic",
  "visual",
  "car",
  "vehicle",
  "bike",
  "bicycle",
  "motorcycle",
  "bus",
  "truck",
  "look",
  "appear",
  "show",
  "display",
];

const VISUAL_NEGATION_PATTERNS = [
  "no logo",
  "no logos",
  "no image",
  "no images",
  "no figure",
  "no figures",
  "no diagram",
  "no diagrams",
  "no icon",
  "no icons",
  "no visual",
  "without logo",
  "without logos",
  "without image",
  "without images",
  "without figure",
  "without figures",
  "blank page",
  "entirely blank",
  "no visible",
  "not visible",
  "none present",
];

const VISUAL_POSITIVE_HINTS = [
  "logo",
  "logos",
  "image",
  "images",
  "figure",
  "figures",
  "diagram",
  "diagrams",
  "chart",
  "graph",
  "icon",
  "icons",
  "photograph",
  "photo",
  "illustration",
  "table",
  "car",
  "vehicle",
  "bike",
  "bicycle",
  "motorcycle",
  "bus",
  "truck",
  "sedan",
  "suv",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an answer for a user message using RAG.
 *
 * @param {object} db
 * @param {number} conversationId
 * @param {number} documentId
 * @param {string} userMessage
 * @returns {{ userMessage: object, assistantMessage: object }}
 */
export async function generateAnswer(
  db,
  conversationId,
  documentId,
  userMessage,
) {
  // Persist user message
  const insertMsg = db.prepare(
    "INSERT INTO messages (conversation_id, role, content, sources) VALUES (?, ?, ?, ?)",
  );
  insertMsg.run(conversationId, "user", userMessage, null);

  const savedUserMsg = db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND role = ? ORDER BY id DESC LIMIT 1",
    )
    .get(conversationId, "user");

  const conversationContext = getRecentConversationMessages(
    db,
    conversationId,
    10,
  );
  const retrievalQuery = buildRetrievalQuery(userMessage, conversationContext);

  // ------------------------------------------------------------------
  // Retrieve relevant chunks
  // ------------------------------------------------------------------
  const searchMode = process.env.SEARCH_MODE || "hybrid";
  const isVisualQuery = detectVisualQuery(retrievalQuery);

  // For visual queries fetch more candidates so vision chunks have a
  // better chance of surfacing even if their BM25/vector score is modest.
  const candidateCount = isVisualQuery ? 12 : 8;

  const results = await hybridSearch(
    db,
    documentId,
    retrievalQuery,
    candidateCount,
    searchMode,
  );

  // If this is a visual query and no vision chunks appeared, explicitly
  // search for vision chunks for the same pages.
  let augmentedResults = results;
  if (isVisualQuery) {
    augmentedResults = await augmentWithVisionChunks(db, documentId, results);
  }

  // ------------------------------------------------------------------
  // Build answer
  // ------------------------------------------------------------------
  let answerContent;
  let sources;

  if (augmentedResults.length === 0) {
    answerContent =
      "I couldn't find any relevant information in the document for your question. " +
      "Please try rephrasing or asking about a different topic covered in the PDF.";
    sources = null;
  } else {
    const rawSources = augmentedResults.map((r) => ({
      chunk_id: r.chunk_id,
      page_number: r.page_number,
      start_offset: r.start_offset,
      end_offset: r.end_offset,
      snippet: r.content.slice(0, 300),
      relevance_score: Math.round(r.score * 100) / 100,
    }));

    sources = dedupeSourcesByPage(rawSources);

    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (geminiApiKey) {
      const handledVisualPresence =
        isVisualQuery && buildVisualPresenceAnswer(userMessage, sources);

      answerContent =
        handledVisualPresence ||
        (await generateWithGemini(
          userMessage,
          sources,
          geminiApiKey,
          isVisualQuery,
          conversationContext,
        ));
    } else {
      answerContent = buildExtractiveAnswer(userMessage, sources);
    }
  }

  // Persist assistant message
  insertMsg.run(
    conversationId,
    "assistant",
    answerContent,
    sources ? JSON.stringify(sources) : null,
  );

  const savedAssistantMsg = db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND role = ? ORDER BY id DESC LIMIT 1",
    )
    .get(conversationId, "assistant");

  return {
    userMessage: savedUserMsg,
    assistantMessage: {
      ...savedAssistantMsg,
      sources: sources || [],
    },
  };
}

// ---------------------------------------------------------------------------
// Visual-query helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether the user's question is about visual content.
 * @param {string} query
 * @returns {boolean}
 */
function detectVisualQuery(query) {
  const lower = query.toLowerCase();
  return VISUAL_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * For visual queries, fetch vision-typed chunks for the same pages that
 * regular search already found.  Merges them in without duplicating pages.
 *
 * @param {object} db
 * @param {number} documentId
 * @param {Array} existingResults
 * @returns {Array}
 */
async function augmentWithVisionChunks(db, documentId, existingResults) {
  if (existingResults.length === 0) return existingResults;

  const existingPageNums = new Set(existingResults.map((r) => r.page_number));

  // Also fetch vision chunks explicitly – they may have scored lower but
  // are the authoritative source for image/logo questions.
  const visionChunks = db
    .prepare(
      `SELECT id, content, page_number, start_offset, end_offset
       FROM chunks
       WHERE document_id = ? AND chunk_type = 'vision'
       ORDER BY page_number`,
    )
    .all(documentId);

  // Prefer vision chunks for pages already in results; also add vision
  // chunks for other pages (score them at MIN_RELEVANCE_SCORE so they
  // pass the threshold but rank below confirmed matches).
  const visionMap = new Map();
  for (const vc of visionChunks) {
    visionMap.set(vc.page_number, vc);
  }

  const merged = [...existingResults];

  for (const [pageNum, vc] of visionMap.entries()) {
    if (!existingPageNums.has(pageNum)) {
      merged.push({
        chunk_id: vc.id,
        score: MIN_RELEVANCE_SCORE,
        content: vc.content,
        page_number: vc.page_number,
        start_offset: vc.start_offset,
        end_offset: vc.end_offset,
      });
    }
  }

  // Re-sort by score descending
  return merged.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Answer generation
// ---------------------------------------------------------------------------

/**
 * Build an extractive (no-LLM) answer from retrieved chunks.
 *
 * @param {string} question
 * @param {Array} sources
 * @returns {string}
 */
function buildExtractiveAnswer(question, sources) {
  const passages = sources
    .map((r) => `**[Page ${r.page_number}]**\n> ${r.snippet.trim()}`)
    .join("\n\n---\n\n");

  const pageSummary = formatSuggestedPages(sources);
  return (
    `Based on the document, here are the most relevant passages for your question:\n\n` +
    `${passages}\n\n` +
    `*${sources.length} relevant section${sources.length !== 1 ? "s" : ""} found. ` +
    `Click on page references to navigate to the source.*\n\n${pageSummary}`
  );
}

/**
 * Generate a synthesised answer using Gemini via Langchain.
 *
 * @param {string} question
 * @param {Array} sources
 * @param {string} apiKey
 * @param {boolean} isVisualQuery
 * @returns {Promise<string>}
 */
async function generateWithGemini(
  question,
  sources,
  apiKey,
  isVisualQuery = false,
  conversationContext = [],
) {
  const context = sources
    .map((r, i) => `[Source ${i + 1}, Page ${r.page_number}]: ${r.snippet}`)
    .join("\n\n");

  const allowedPages = [...new Set(sources.map((s) => s.page_number))].join(
    ", ",
  );
  const allowedPageSet = new Set(sources.map((s) => s.page_number));

  const visualInstruction = isVisualQuery
    ? `\n- Some sources are AI-generated visual descriptions of page images. ` +
      `Use them to answer questions about logos, diagrams, figures, colours, and layout.`
    : "";

  const conversationInstruction =
    conversationContext.length > 0
      ? `\nConversation context (latest messages first):\n${formatConversationContext(conversationContext)}\n\n` +
        `Interpret pronouns and follow-up confirmations (for example: "yes it exists") using this context. ` +
        `If context is still ambiguous, ask for clarification instead of guessing.\n`
      : "";

  const prompt =
    `You are an expert assistant answering questions about a PDF document.\n` +
    `Answer the user's question using ONLY the provided document excerpts.\n\n` +
    `STRICT RULES:\n` +
    `- Cite every factual claim with [Page X] immediately after the claim.\n` +
    `- You may ONLY cite pages from this exact list: ${allowedPages}.\n` +
    `- Do NOT invent page numbers or cite pages not in that list.\n` +
    `- If the excerpts do not contain enough information, say so clearly.\n` +
    `- Do not speculate beyond what the excerpts state.` +
    `${visualInstruction}\n\n` +
    `${conversationInstruction}` +
    `Document excerpts:\n${context}\n\n` +
    `Question: ${question}\n\n` +
    `Answer:`;

  const candidateModels = [
    DEFAULT_GEMINI_MODEL,
    ...GEMINI_FALLBACK_MODELS.filter((m) => m !== DEFAULT_GEMINI_MODEL),
  ];

  let lastError = null;

  for (let i = 0; i < candidateModels.length; i++) {
    const modelName = candidateModels[i];

    try {
      const model = new ChatGoogleGenerativeAI({
        modelName,
        apiKey,
        temperature: 0.3, // Lower temperature → more faithful citations
        maxOutputTokens: 2048,
      });

      const response = await model.invoke(prompt);
      const normalized = normalizeCitations(
        normalizeModelContent(response.content),
        allowedPageSet,
      );
      const cleaned = stripSuggestedPagesFooter(normalized);
      return `${cleaned}\n\n${formatSuggestedPages(sources)}`;
    } catch (err) {
      lastError = err;
      const canTryNext = i < candidateModels.length - 1;

      if (canTryNext && shouldTryAnotherGeminiModel(err)) {
        console.warn(
          `Gemini model ${modelName} unavailable. Trying ${candidateModels[i + 1]}…`,
        );
        continue;
      }

      break;
    }
  }

  console.error(
    `Gemini failed for [${candidateModels.join(", ")}], falling back to extractive:`,
    lastError?.message || "Unknown error",
  );
  return buildExtractiveAnswer(question, sources);
}

// ---------------------------------------------------------------------------
// Source deduplication & formatting
// ---------------------------------------------------------------------------

/**
 * Keep the highest-scoring chunk per page, then cap at MAX_CITATIONS.
 * This is the primary guard against irrelevant page citations.
 *
 * @param {Array} sources
 * @returns {Array}
 */
function dedupeSourcesByPage(sources) {
  // Filter out low-relevance sources first
  const relevant = sources.filter(
    (s) => s.relevance_score >= MIN_RELEVANCE_SCORE,
  );

  const byPage = new Map();
  for (const source of relevant) {
    const existing = byPage.get(source.page_number);
    if (!existing || source.relevance_score > existing.relevance_score) {
      byPage.set(source.page_number, source);
    }
  }

  return Array.from(byPage.values())
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, MAX_CITATIONS); // Hard cap on number of cited pages
}

/**
 * Build a concise "Suggested pages" footer.
 * @param {Array<{page_number: number}>} sources
 * @returns {string}
 */
function formatSuggestedPages(sources) {
  const pages = [...new Set(sources.map((s) => s.page_number))].sort(
    (a, b) => a - b,
  );
  return `Suggested pages: ${pages.map((p) => `Page ${p}`).join(", ")}`;
}

/**
 * Deterministic answer path for yes/no visual-presence questions.
 * Prevents vague or contradictory model responses for logo/image checks.
 *
 * @param {string} question
 * @param {Array<{page_number:number,snippet:string}>} sources
 * @returns {string|null}
 */
function buildVisualPresenceAnswer(question, sources) {
  if (!isVisualPresenceQuestion(question) || sources.length === 0) {
    return null;
  }

  const positives = [];
  const negatives = [];

  for (const source of sources) {
    const text = source.snippet.toLowerCase();
    const hasPositiveHint = VISUAL_POSITIVE_HINTS.some((kw) =>
      text.includes(kw),
    );
    const hasNegation = VISUAL_NEGATION_PATTERNS.some((kw) =>
      text.includes(kw),
    );

    if (hasPositiveHint && !hasNegation) {
      positives.push(source.page_number);
    } else {
      negatives.push(source.page_number);
    }
  }

  const uniquePositives = [...new Set(positives)].sort((a, b) => a - b);
  const inspectedPages = [...new Set(sources.map((s) => s.page_number))].sort(
    (a, b) => a - b,
  );

  if (uniquePositives.length > 0) {
    const citationText = uniquePositives.map((p) => `[Page ${p}]`).join(", ");
    return (
      `Yes, visual elements appear to be present on ${citationText}. ` +
      `Please open those pages to confirm the exact logo/image details.\n\n` +
      `${formatSuggestedPages(sources)}`
    );
  }

  const inspectedCitation = inspectedPages.map((p) => `[Page ${p}]`).join(", ");
  return (
    `No clear logo/image evidence appears in the analyzed excerpts from ${inspectedCitation}. ` +
    `If you want a broader check, increase vision pages and reprocess the document.\n\n` +
    `${formatSuggestedPages(sources)}`
  );
}

/**
 * Detect yes/no style questions about visual presence.
 * @param {string} question
 * @returns {boolean}
 */
function isVisualPresenceQuestion(question) {
  const q = question.toLowerCase();
  return (
    /(any|find|contains?|present|exist|see|visible)/.test(q) &&
    /(logo|image|figure|diagram|icon|photo|visual|car|vehicle|bike|bus|truck)/.test(
      q,
    )
  );
}

/**
 * Normalize model citations to [Page X] and remove citations to pages not in source set.
 * @param {string} text
 * @param {Set<number>} allowedPages
 * @returns {string}
 */
function normalizeCitations(text, allowedPages) {
  let output = text;

  output = output.replace(/\[(\d+)\]/g, (full, num) => {
    const page = Number(num);
    if (allowedPages.has(page)) {
      return `[Page ${page}]`;
    }
    return "";
  });

  output = output.replace(/\[page\s*(\d+)\]/gi, (full, num) => {
    const page = Number(num);
    if (allowedPages.has(page)) {
      return `[Page ${page}]`;
    }
    return "";
  });

  output = output.replace(/\s{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  return output.trim();
}

/**
 * Remove any model-generated "Suggested pages" footer so we can append one
 * canonical footer without duplicates.
 * @param {string} text
 * @returns {string}
 */
function stripSuggestedPagesFooter(text) {
  return text
    .replace(/^\s*Suggested pages\s*:[^\n]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Normalise Langchain model output into a plain string.
 * @param {unknown} content
 * @returns {string}
 */
function normalizeModelContent(content) {
  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part)
          return String(part.text || "");
        return "";
      })
      .join("\n")
      .trim();
  }

  return String(content || "").trim();
}

/**
 * Fetch latest conversation messages (ascending by time after limit).
 * @param {object} db
 * @param {number} conversationId
 * @param {number} limit
 * @returns {Array<{id:number,role:string,content:string}>}
 */
function getRecentConversationMessages(db, conversationId, limit = 10) {
  return db
    .prepare(
      `SELECT id, role, content
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(conversationId, limit)
    .reverse();
}

/**
 * Build a retrieval query that resolves short/ambiguous follow-ups.
 * @param {string} userMessage
 * @param {Array<{id:number,role:string,content:string}>} messages
 * @returns {string}
 */
function buildRetrievalQuery(userMessage, messages) {
  const current = String(userMessage || "").trim();
  if (!current) return "";

  if (!isAmbiguousFollowUp(current)) {
    return current;
  }

  const previousUserTurns = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content?.trim())
    .filter(Boolean);

  const previousQuestion =
    previousUserTurns.length >= 2
      ? previousUserTurns[previousUserTurns.length - 2]
      : previousUserTurns.length === 1
        ? previousUserTurns[0]
        : "";

  if (!previousQuestion) {
    return current;
  }

  return `Previous user question: ${previousQuestion}\nFollow-up: ${current}`;
}

/**
 * Detect short follow-ups that depend on previous turn meaning.
 * @param {string} text
 * @returns {boolean}
 */
function isAmbiguousFollowUp(text) {
  const t = text.toLowerCase().trim();
  if (t.length <= 3) return true;

  const startsWithFollowUpWord =
    /^(yes|no|it|this|that|these|those|also|ok|okay|correct|right)\b/.test(t);
  const containsPronoun = /\b(it|this|that|they|them|its|those|these)\b/.test(
    t,
  );
  const isShort = t.split(/\s+/).length <= 6;

  return startsWithFollowUpWord || (containsPronoun && isShort);
}

/**
 * Render conversation turns for prompt context.
 * @param {Array<{role:string,content:string}>} messages
 * @returns {string}
 */
function formatConversationContext(messages) {
  return messages
    .slice(-10)
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content || "")
          .trim()
          .slice(0, 500)}`,
    )
    .join("\n");
}

/**
 * Decide whether the error warrants retrying with another Gemini model.
 * @param {Error & {status?: number, code?: number|string}} err
 * @returns {boolean}
 */
function shouldTryAnotherGeminiModel(err) {
  const message = String(err?.message || "").toLowerCase();
  return (
    err?.status === 404 ||
    err?.code === 404 ||
    message.includes("404") ||
    (message.includes("model") && message.includes("not found")) ||
    message.includes("not supported for generatecontent")
  );
}
