# PDF Q&A Bot

A PDF-based Q&A Chatbot with Advanced RAG (Retrieval-Augmented Generation) and multimodal support. Upload PDFs, ask questions, and get answers with source section highlighting.

## Features

- **PDF Upload & Processing** — Upload PDFs; text is automatically extracted and indexed
- **Multimodal Support** — Handles both text content and embedded images via OCR (Tesseract.js)
- **BM25 RAG Search** — Local retrieval engine using BM25 ranking — no external API keys required
- **Source Highlighting** — Click source references to navigate to the relevant page in the PDF viewer
- **Split-Pane Interface** — Resizable document viewer (left) + chat interface (right)
- **Full Authentication** — JWT-based register/login system
- **Optional LLM Integration** — Automatically uses OpenAI for generative answers when API key is set; falls back to extractive mode otherwise

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
3. **Index** — Each chunk is tokenized (lowercase, stopword removal) and indexed using BM25 term frequencies in SQLite
4. **Query** — User questions are tokenized and matched against the index using BM25 scoring (k1=1.5, b=0.75)
5. **Answer** — Top-5 relevant chunks are returned with page references. If an LLM API key is configured, a synthesized answer is generated instead

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

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Server port |
| `JWT_SECRET` | Yes (prod) | `dev-secret-...` | JWT signing secret |
| `OPENAI_API_KEY` | No | — | Enables generative RAG mode |
| `NEXT_PUBLIC_API_URL` | No | `http://localhost:3001/api` | API base URL |

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

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Register a new user |
| POST | `/api/auth/login` | No | Login and get JWT token |
| GET | `/api/documents` | Yes | List user's documents |
| POST | `/api/documents` | Yes | Upload a PDF (multipart) |
| GET | `/api/documents/:id` | Yes | Get document metadata |
| GET | `/api/documents/:id/file` | Yes | Serve the PDF file |
| GET | `/api/documents/:id/chunks` | Yes | Get text chunks |
| DELETE | `/api/documents/:id` | Yes | Delete a document |
| GET | `/api/conversations/document/:id` | Yes | List conversations |
| POST | `/api/conversations/document/:id` | Yes | Create conversation |
| GET | `/api/conversations/:id/messages` | Yes | Get messages |
| POST | `/api/conversations/:id/chat` | Yes | Send message (RAG) |
| GET | `/api/health` | No | Health check |

## Tech Stack

- **Frontend:** Next.js 15, React 19, Tailwind CSS v4, TypeScript, pdfjs-dist, react-resizable-panels, Lucide icons
- **Backend:** Express.js, better-sqlite3, bcryptjs, jsonwebtoken, multer, pdf-parse, tesseract.js, zod
- **Testing:** Node.js test runner + supertest (server), Vitest + React Testing Library (frontend)
