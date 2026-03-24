# PDF Q&A Bot - Test Coverage and Expected Behavior

## 1) Latest Automated Test Status

- Frontend: 39/39 tests passed (`npm run test --workspace=frontend`)
- Server: 33/33 tests passed (`npm run test --workspace=server`)
- Total: 72/72 tests passed

---

## 2) Passed Automated Test Cases (Current Suite)

## 2.1 Server Tests

### Auth API (`server/src/__tests__/auth.test.js`)

- Register a new user successfully (201 + token + user payload)
- Reject duplicate email registration (409)
- Reject invalid registration payload (400)
- Login with valid credentials (200 + token)
- Reject login with wrong password (401)
- Reject login for non-existent user (401)

### Chat API (`server/src/__tests__/chat.test.js`)

- Send a message and receive user/assistant messages
- Return source list with page metadata in assistant response
- Persist messages in conversation history
- Reject empty chat message payload (400)
- Reject unauthorized chat access (401)

### Documents API (`server/src/__tests__/documents.test.js`)

- Return empty document list initially
- Require authentication for document listing
- Reject non-PDF upload
- Upload valid PDF and return `processing` status
- List uploaded documents after upload
- Fetch single document by id
- Return 404 for non-existent document id

### Chunker (`server/src/__tests__/chunker.test.js`)

- Split long text into multiple chunks
- Preserve page numbers in chunks
- Track offsets (start/end)
- Handle empty text safely
- Handle short text as single chunk
- Chunk multi-page input and preserve sequential chunk index

### Search Index (`server/src/__tests__/search-index.test.js`)

- Tokenize text to lowercase words
- Remove stopwords
- Remove punctuation
- Ignore short tokens
- Retrieve relevant chunks for query
- Rank results by relevance
- Return page numbers with results
- Return no/low relevance for unrelated query
- Respect topK limit

## 2.2 Frontend Tests

### API Client (`frontend/src/__tests__/api.test.ts`)

- Login request returns token/user correctly
- API client throws error on non-OK response
- Authorization header included when token is set

### Auth Form (`frontend/src/__tests__/auth-form.test.tsx`)

- Login mode renders correctly
- Register mode includes name field
- Submit callback receives entered form data
- Error message shown on submit failure
- Toggle between login and register modes

### Chat Message UI (`frontend/src/__tests__/chat-interface.test.tsx`)

- Render user message bubble
- Render assistant message bubble
- Render page source badges
- Trigger source-click callback from badge

### Shared UI Components (`frontend/src/__tests__/components.test.tsx`)

- Badge variants (default/success/destructive/warning)
- Button interactions and disabled state
- Input rendering, change handling, disabled state
- Card rendering with title/content
- ChatMessage source rendering and source click callback

### Utility Functions (`frontend/src/__tests__/utils.test.ts`)

- Class merge utility behavior
- Date formatting behavior
- File-size formatting (bytes/KB/MB/zero)

---

## 3) Bot-Focused Functional QA Matrix (Text + Image)

This section is focused on the retrieval bot behavior your team should validate repeatedly.

### 3.1 Text Question Scenarios

| ID          | Question Type                  | Sample Question                                     | Expected Answer Behavior                                                        |
| ----------- | ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| BOT-TEXT-01 | Direct fact lookup             | "What is the capital of France?"                    | Answer includes fact + page citation like `[Page X]`; source badge shown in UI. |
| BOT-TEXT-02 | Multi-sentence summary         | "Summarize section about BM25"                      | Concise summary from retrieved chunks only, no hallucinated pages.              |
| BOT-TEXT-03 | Multi-page topic               | "Compare intro and conclusion"                      | Answer may cite multiple pages; Suggested pages list unique sorted pages.       |
| BOT-TEXT-04 | Follow-up in same conversation | "And what about limitations?"                       | Uses ongoing conversation context and returns document-grounded continuation.   |
| BOT-TEXT-05 | Weak evidence                  | "Explain theorem proof details" when details absent | Bot says evidence is insufficient and avoids fabricated claims.                 |

### 3.2 Image/Visual Question Scenarios

| ID         | Question Type         | Sample Question                              | Expected Answer Behavior                                                          |
| ---------- | --------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| BOT-VIS-01 | Object presence       | "Is there a car image in this PDF?"          | Bot should answer yes/no based on vision chunks and cite relevant page(s).        |
| BOT-VIS-02 | Logo presence         | "Do you see any logo?"                       | Uses visual descriptions, returns page citations, avoids random brand guesses.    |
| BOT-VIS-03 | Figure/diagram        | "What does the figure on page 2 show?"       | Explains from visual + OCR context for that page; includes citation.              |
| BOT-VIS-04 | Visual negative check | "Any logos in this document?" (none present) | Clear negative response like "No clear logo/image evidence..." + inspected pages. |
| BOT-VIS-05 | Mixed text + visual   | "What does the chart say about growth?"      | Combines chart text/OCR with visual interpretation and cites page.                |

### 3.3 Source and Citation Expectations

- Citations should only reference pages returned by retrieval context.
- Duplicate page chips should not repeat in answer or Suggested pages.
- Clicking a source badge should navigate PDF viewer to that page.
- Suggested pages footer should appear once and remain deduplicated.

---

## 4) Out-of-PDF Question Handling (Required Behavior)

When the user asks something not present in the uploaded PDF, expected behavior:

- Bot should return a "not found / insufficient evidence" style response.
- Bot should not invent facts or cite non-existent pages.
- Response should guide user to rephrase or ask about PDF-covered topics.

### Example

Input:

- "Who won FIFA World Cup 1998?" (when PDF is about wildlife)

Expected output style:

- "I couldn't find relevant information in the document for this question. Please ask about topics covered in this PDF."
- No fabricated citations.

---

## 5) Fallback and Resilience Test Cases

These are critical reliability paths implemented in the bot pipeline.

### 5.1 LLM Fallbacks

| ID        | Scenario                                             | Expected Behavior                                                        |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| FB-LLM-01 | Primary Gemini model unavailable (404/not supported) | System retries configured fallback models automatically.                 |
| FB-LLM-02 | All Gemini models fail                               | System falls back to extractive answer from retrieved chunks.            |
| FB-LLM-03 | Missing Gemini API key                               | System skips generative synthesis and still returns extractive response. |

### 5.2 Vision Fallbacks

| ID        | Scenario                                                | Expected Behavior                                             |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| FB-VIS-01 | Page rasterization failure (`Image or Canvas expected`) | Continue processing other pages; do not fail entire document. |
| FB-VIS-02 | Some page renders fail                                  | Attempt direct PDF-to-Gemini fallback for failed pages.       |
| FB-VIS-03 | Vision disabled                                         | Processing still completes with text-only chunks.             |

### 5.3 Vector/Search Fallbacks

| ID        | Scenario                  | Expected Behavior                                                       |
| --------- | ------------------------- | ----------------------------------------------------------------------- |
| FB-VEC-01 | Pinecone index missing    | Auto-create index (if enabled), wait until ready, continue upsert.      |
| FB-VEC-02 | Pinecone unavailable      | Graceful degraded mode with local BM25 retrieval path still functional. |
| FB-VEC-03 | Delete by metadata filter | Uses valid filter shape and removes document vectors safely.            |

---

## 6) Authentication and Authorization Coverage

- Register/login flow issues JWT token.
- Protected routes reject missing/invalid token (401).
- Cross-user access to protected resources is blocked by auth middleware.
- Frontend API client attaches bearer token for authenticated requests.

---

## 7) Non-Functional Requirements (NFR) Checklist

These are key NFRs and how to validate them in QA.

### Reliability

- Upload should not double-submit on repeated clicks.
- Processing should complete even with partial vision failures.
- Chat should persist conversation history and reload recent messages correctly.

### Performance

- Document list polling should stop when no document is in `processing` state.
- Chat should window recent messages (latest N) to avoid heavy payloads.
- PDF zoom should stay clear (DPR-aware canvas rendering).

### Usability

- Upload loader should be smooth and non-jittering.
- Delete action should show spinner in delete icon while in progress.
- PDF source navigation should jump to cited page and avoid misleading overlays.

### Security

- Auth endpoints validate payload and credentials.
- Protected API routes enforce JWT auth.
- Non-PDF file uploads are rejected.

### Observability

- Processing pipeline emits clear logs per document stage.
- Vision/model fallback attempts are logged with reason.
- Pinecone init/index state and degraded mode reasons are visible in logs.

---

## 8) Recommended Regression Test Set (High Priority)

Run this quick suite before each release:

1. Upload 1 text-only PDF -> ask factual question -> verify page citation and badge navigation.
2. Upload 1 image-heavy PDF -> ask object/logo question -> verify visual answer and correct page.
3. Ask out-of-PDF question -> verify "not found/insufficient evidence" response.
4. Force model fallback (invalid primary model) -> verify fallback model or extractive response.
5. Delete document while processing another -> verify delete spinner and no UI freeze.
6. Validate split view and zoom controls in PDF viewer.

---

## 9) Notes for Expected Bot Answer Quality

- Answers should be grounded to retrieved chunks and page citations.
- For visual questions, answers should prefer vision-derived evidence.
- If evidence is missing or ambiguous, assistant should clearly say so.
- Never fabricate pages, logos, brands, or facts outside the PDF context.
