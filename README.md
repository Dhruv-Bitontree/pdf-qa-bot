# PDF Q&A Bot

A PDF-based Q&A Chatbot with Advanced RAG (Retrieval-Augmented Generation) and multimodal support. Upload PDFs, ask questions, and get answers with source section highlighting.

## Features

- **PDF Upload & Processing** — Upload PDFs; text is automatically extracted and indexed
- **Multimodal Support** — Handles both text content and embedded images via OCR (Tesseract.js)
- **Hybrid Search** — Combines BM25 keyword search with Pinecone semantic vector search using Reciprocal Rank Fusion (RRF)
- **Semantic Embeddings** — Generates embeddings using OpenRouter's text-embedding-3-large model (3072 dimensions)
- **AI-Powered Answers** — Uses Google Gemini 1.5 Pro via Langchain for high-quality answer generation
- **Source Highlighting** — Click source references to navigate to the relevant page in the PDF viewer
- **Split-Pane Interface** — Resizable document viewer (left) + chat interface (right)
- **Full Authentication** — JWT-based register/login system
- **Graceful Degradation** — Falls back to BM25-only search when Pinecone is unavailable

## Architecture

```
pdf-qa-bot/
├── server/           # Express REST API + SQLite
│   └── src/
│       ├── routes/       # auth, documents, conversations, chat
│       ├── services/     # pdf-processor, chunker, search-index (BM25), rag, ocr
│       ├── middleware/   # JWT authentication
│       └── db.js         # SQLite schema (users, documents, chunks, term_index, conversations, messages)
└── frontend/         # Next.js 15 + Tailwind CSS
    └── src/
        ├── app/          # Pages: login, dashboard, document viewer
        ├── components/   # PDF viewer, chat interface, split-pane, auth form
        └── lib/          # API client, auth context, utilities
```

### How RAG Works

1. **Upload** — PDF text is extracted page-by-page using `pdf-parse`; embedded images are OCR'd with Tesseract.js
2. **Chunk** — Text is split into ~500-character overlapping chunks, respecting sentence boundaries
3. **Index** — Each chunk is indexed using both BM25 (keyword) and Pinecone (semantic embeddings)
4. **Embed** — Chunks are converted to 3072-dimensional vectors using OpenRouter's text-embedding-3-large model
5. **Query** — User questions are processed through hybrid search combining BM25 and Pinecone results
6. **Merge** — Results from both search methods are merged using Reciprocal Rank Fusion (RRF)
7. **Answer** — Top-5 relevant chunks are passed to Google Gemini 1.5 Pro for answer generation with source citations

## Quick Start

### Prerequisites

- Node.js 20+
- npm 10+

### Setup

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start both server and frontend
npm run dev
```

The server runs on `http://localhost:3001` and the frontend on `http://localhost:3000`.

### Environment Variables

| Variable                   | Required   | Default                             | Description                                                                               |
| -------------------------- | ---------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `PORT`                     | No         | `3001`                              | Server port                                                                               |
| `JWT_SECRET`               | Yes (prod) | `dev-secret-...`                    | JWT signing secret                                                                        |
| `OPENROUTER_API_KEY`       | No         | —                                   | OpenRouter API key for embeddings (enables semantic search)                               |
| `GEMINI_API_KEY`           | No         | —                                   | Google Gemini API key for answer generation                                               |
| `GEMINI_MODEL`             | No         | `gemini-2.5-pro`                    | Primary Gemini model used for answer generation                                           |
| `GEMINI_FALLBACK_MODELS`   | No         | `gemini-2.5-flash,gemini-1.5-flash` | Comma-separated fallback Gemini models tried when primary is unavailable                  |
| `GEMINI_VISION_ENABLED`    | No         | `false`                             | Enable page-image vision extraction during PDF processing                                 |
| `GEMINI_VISION_MAX_PAGES`  | No         | `10`                                | Maximum number of PDF pages processed by Gemini Vision per upload                         |
| `GEMINI_VISION_TIMEOUT_MS` | No         | `90000`                             | Total timeout for the Vision stage to avoid long `processing` states                      |
| `PINECONE_API_KEY`         | No         | —                                   | Pinecone API key for vector storage                                                       |
| `PINECONE_INDEX_NAME`      | No         | `pdf-qa-bot`                        | Pinecone index name                                                                       |
| `PINECONE_INDEX_HOST`      | No         | —                                   | Optional Pinecone index host from dashboard (recommended when using custom index routing) |
| `PINECONE_CLOUD`           | No         | `aws`                               | Cloud to use when auto-creating a missing Pinecone index                                  |
| `PINECONE_REGION`          | No         | `us-east-1`                         | Region to use when auto-creating a missing Pinecone index                                 |
| `SEARCH_MODE`              | No         | `hybrid`                            | Search mode: `bm25`, `pinecone`, or `hybrid`                                              |
| `NEXT_PUBLIC_API_URL`      | No         | `http://localhost:3001/api`         | API base URL                                                                              |

If Pinecone is enabled, the server will auto-create the configured index when missing (3072 dimensions, cosine metric). If creation fails, check `PINECONE_CLOUD` and `PINECONE_REGION`.

## Testing

```bash
# Run all tests
npm test

# Server tests only (33 tests)
npm run test:server

# Frontend tests only (39 tests)
npm run test:frontend
```

### Test Coverage

**Server (33 tests):**

- Auth: register, login, validation, duplicate email, wrong password
- Documents: CRUD, upload, file type validation, authorization
- Chunker: text splitting, boundary handling, multi-page, edge cases
- Search Index: tokenization, stopword removal, BM25 ranking, relevance
- Chat: message sending, source retrieval, persistence, validation

**Frontend (39 tests):**

- API client: requests, error handling, auth headers
- Auth form: rendering, submission, error display, mode toggle
- Chat: message rendering, source badges, click handlers
- Components: UI component rendering and behavior
- Utilities: formatting functions

## API Endpoints

| Method | Path                              | Auth | Description                          |
| ------ | --------------------------------- | ---- | ------------------------------------ |
| POST   | `/api/auth/register`              | No   | Register a new user                  |
| POST   | `/api/auth/login`                 | No   | Login and get JWT token              |
| GET    | `/api/documents`                  | Yes  | List user's documents                |
| POST   | `/api/documents`                  | Yes  | Upload a PDF (multipart)             |
| GET    | `/api/documents/:id`              | Yes  | Get document metadata                |
| GET    | `/api/documents/:id/file`         | Yes  | Serve the PDF file                   |
| GET    | `/api/documents/:id/chunks`       | Yes  | Get text chunks                      |
| DELETE | `/api/documents/:id`              | Yes  | Delete a document                    |
| POST   | `/api/documents/:id/reindex`      | Yes  | Regenerate embeddings for a document |
| GET    | `/api/search/status`              | Yes  | Get search system status             |
| GET    | `/api/conversations/document/:id` | Yes  | List conversations                   |
| POST   | `/api/conversations/document/:id` | Yes  | Create conversation                  |
| GET    | `/api/conversations/:id/messages` | Yes  | Get messages                         |
| POST   | `/api/conversations/:id/chat`     | Yes  | Send message (RAG)                   |
| GET    | `/api/health`                     | No   | Health check                         |

## Tech Stack

- **Frontend:** Next.js 15, React 19, Tailwind CSS v4, TypeScript, pdfjs-dist, react-resizable-panels, Lucide icons
- **Backend:** Express.js, sql.js (SQLite), bcryptjs, jsonwebtoken, multer, pdf-parse, tesseract.js, zod
- **AI/ML:** OpenRouter (embeddings), Pinecone (vector storage), Google Gemini 1.5 Pro (via Langchain)
- **Testing:** Node.js test runner + supertest (server), Vitest + React Testing Library (frontend)
