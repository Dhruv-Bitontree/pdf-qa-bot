# Requirements Document

## Introduction

This document specifies the requirements for enhancing the PDF Q&A Bot with improved database handling and semantic vector search capabilities. The system currently uses sql.js which has foreign key constraint issues during transactions, and relies solely on BM25 keyword search. This enhancement will migrate to better-sqlite3 for robust database operations and integrate Pinecone for semantic vector search, enabling hybrid search that combines keyword and semantic retrieval for improved answer quality.

## Glossary

- **System**: The PDF Q&A Bot server application
- **Database_Manager**: The component responsible for SQLite database operations
- **Vector_Store**: Pinecone vector database for storing and retrieving embeddings
- **Embedding_Generator**: Component that creates vector embeddings using OpenRouter's API
- **RAG_Service**: Component that generates answers using Gemini via Langchain for multimodal support
- **Search_Engine**: Component that performs document retrieval using BM25, Pinecone, or hybrid mode
- **PDF_Processor**: Component that processes uploaded PDF documents
- **Chunk**: A segment of document text with metadata (page number, offsets)
- **Embedding**: A numerical vector representation of text content
- **BM25**: A keyword-based ranking algorithm for text retrieval
- **RRF**: Reciprocal Rank Fusion algorithm for merging ranked search results
- **Hybrid_Search**: Search strategy combining BM25 and semantic vector search

## Requirements

### Requirement 1: Database Migration to better-sqlite3

**User Story:** As a developer, I want to replace sql.js with better-sqlite3, so that foreign key constraints work correctly during transactions and document uploads succeed without errors.

#### Acceptance Criteria

1. THE Database_Manager SHALL use better-sqlite3 instead of sql.js for all database operations
2. WHEN a document is uploaded, THE PDF_Processor SHALL successfully insert chunks with foreign key constraints enforced
3. WHEN transactions are executed, THE Database_Manager SHALL properly handle foreign key relationships without constraint violations
4. THE Database_Manager SHALL maintain backward compatibility with the existing database schema
5. WHEN the database is initialized, THE Database_Manager SHALL enable foreign key constraint enforcement
6. THE Database_Manager SHALL provide synchronous API methods compatible with the existing codebase

### Requirement 2: Embedding Generation

**User Story:** As a system component, I want to generate vector embeddings for document chunks, so that semantic search can be performed on document content.

#### Acceptance Criteria

1. WHEN a document chunk is created, THE Embedding_Generator SHALL generate a vector embedding using OpenRouter with the openai/text-embedding-3-large model
2. WHEN the OpenRouter API is unavailable, THE Embedding_Generator SHALL log the error and allow the system to continue with BM25-only search
3. WHEN generating embeddings, THE Embedding_Generator SHALL handle API rate limits gracefully with exponential backoff
4. THE Embedding_Generator SHALL batch embedding requests when processing multiple chunks to optimize API usage
5. WHEN embedding generation fails for a chunk, THE System SHALL mark the chunk as processed but log the failure without blocking document upload

### Requirement 3: Pinecone Vector Storage Integration

**User Story:** As a system component, I want to store document chunk embeddings in Pinecone, so that semantic similarity search can be performed efficiently.

#### Acceptance Criteria

1. WHEN a chunk embedding is generated, THE Vector_Store SHALL store it in Pinecone with metadata including document_id, chunk_id, page_number, and content preview
2. WHEN Pinecone is not configured, THE System SHALL operate normally using only BM25 search
3. WHEN storing embeddings, THE Vector_Store SHALL use the configured Pinecone index name from environment variables
4. THE Vector_Store SHALL limit content preview metadata to 500 characters to respect Pinecone metadata size limits
5. WHEN Pinecone API calls fail, THE Vector_Store SHALL log errors and allow the system to fall back to BM25 search
6. WHEN a document is deleted, THE Vector_Store SHALL delete all associated embeddings from Pinecone

### Requirement 4: Hybrid Search Implementation

**User Story:** As a user, I want the system to use both keyword and semantic search, so that I get more relevant answers to my questions regardless of exact keyword matches.

#### Acceptance Criteria

1. WHEN a search query is received, THE Search_Engine SHALL retrieve results from both BM25 and Pinecone sources
2. WHEN merging search results, THE Search_Engine SHALL use Reciprocal Rank Fusion (RRF) to combine rankings from both sources
3. THE Search_Engine SHALL support three search modes: bm25-only, pinecone-only, and hybrid
4. WHEN Pinecone is unavailable in hybrid mode, THE Search_Engine SHALL automatically fall back to BM25-only search
5. WHEN returning search results, THE Search_Engine SHALL include relevance scores normalized between 0 and 1
6. THE Search_Engine SHALL return the top-k results as configured, with a default of 5 results

### Requirement 5: Environment Configuration

**User Story:** As a system administrator, I want to configure Pinecone and search behavior through environment variables, so that I can control system behavior without code changes.

#### Acceptance Criteria

1. THE System SHALL read PINECONE_API_KEY from environment variables for Pinecone authentication
2. THE System SHALL read PINECONE_INDEX_NAME from environment variables to specify the target index
3. THE System SHALL read SEARCH_MODE from environment variables with valid values: bm25, pinecone, or hybrid
4. WHEN SEARCH_MODE is not specified, THE System SHALL default to hybrid mode
5. WHEN PINECONE_API_KEY is not provided, THE System SHALL operate in BM25-only mode regardless of SEARCH_MODE setting
6. THE System SHALL use OPENROUTER_API_KEY environment variable for embedding generation
7. THE System SHALL use GEMINI_API_KEY environment variable for answer generation via Langchain
8. WHEN GEMINI_API_KEY is not provided, THE System SHALL fall back to extractive answer mode

### Requirement 6: API Endpoint Enhancements

**User Story:** As a developer, I want enhanced API endpoints for managing vector search, so that I can monitor system status and reindex documents when needed.

#### Acceptance Criteria

1. THE System SHALL provide a GET /api/search/status endpoint that returns Pinecone connection status and current search mode
2. THE System SHALL provide a POST /api/documents/:id/reindex endpoint that regenerates and stores embeddings for an existing document
3. WHEN a document is uploaded, THE System SHALL automatically generate embeddings and store them in Pinecone if configured
4. WHEN the reindex endpoint is called, THE System SHALL delete existing embeddings and create new ones for all chunks
5. THE status endpoint SHALL return information including: pinecone_configured, pinecone_connected, search_mode, and embedding_model

### Requirement 7: Error Handling and Graceful Degradation

**User Story:** As a user, I want the system to continue working even when external services fail, so that I can always access my documents and get answers.

#### Acceptance Criteria

1. WHEN Pinecone API calls fail, THE System SHALL log detailed error messages and continue operation with BM25 search
2. WHEN OpenRouter embedding API calls fail, THE System SHALL log the error and mark the document as ready without embeddings
3. WHEN network errors occur during embedding generation, THE System SHALL retry up to 3 times with exponential backoff
4. THE System SHALL provide clear error messages distinguishing between configuration errors and runtime failures
5. WHEN operating in degraded mode, THE System SHALL include a notice in API responses indicating reduced functionality
6. THE System SHALL never fail document upload due to embedding or vector storage failures

### Requirement 8: Data Consistency and Cleanup

**User Story:** As a system administrator, I want embeddings to stay synchronized with document data, so that search results remain accurate and storage is efficiently used.

#### Acceptance Criteria

1. WHEN a document is deleted, THE System SHALL delete all associated embeddings from Pinecone
2. WHEN a chunk is deleted, THE System SHALL delete the corresponding embedding from Pinecone
3. THE System SHALL use chunk_id as the unique identifier for embeddings in Pinecone
4. WHEN reindexing a document, THE System SHALL delete old embeddings before creating new ones
5. THE System SHALL handle Pinecone deletion failures gracefully without blocking document deletion operations

### Requirement 9: Testing and Validation

**User Story:** As a developer, I want comprehensive tests for the new functionality, so that I can confidently deploy changes without breaking existing features.

#### Acceptance Criteria

1. THE System SHALL include unit tests for better-sqlite3 database operations including foreign key constraints
2. THE System SHALL include unit tests for embedding generation with mocked OpenRouter API responses
3. THE System SHALL include unit tests for Pinecone integration with mocked Pinecone client
4. THE System SHALL include unit tests for the RRF algorithm with known input/output pairs
5. THE System SHALL include integration tests verifying hybrid search returns merged results
6. THE System SHALL include tests verifying graceful degradation when Pinecone is unavailable
7. ALL existing tests SHALL pass with the new implementation

### Requirement 10: Performance and Scalability

**User Story:** As a user, I want document processing to complete in reasonable time, so that I can start asking questions quickly after upload.

#### Acceptance Criteria

1. WHEN processing documents, THE Embedding_Generator SHALL batch up to 100 chunks per API request to OpenRouter
2. WHEN storing embeddings, THE Vector_Store SHALL batch upsert operations to Pinecone in groups of 100
3. THE System SHALL process embedding generation asynchronously without blocking the document upload response
4. WHEN rate limits are encountered, THE System SHALL implement exponential backoff with a maximum wait time of 60 seconds
5. THE System SHALL log processing progress for documents with more than 50 chunks

### Requirement 11: Multimodal Answer Generation with Gemini

**User Story:** As a user, I want the system to use Gemini for answer generation, so that I can get high-quality answers that understand both text and images from my PDFs.

#### Acceptance Criteria

1. WHEN generating answers, THE RAG_Service SHALL use Gemini via Langchain as the primary LLM
2. THE RAG_Service SHALL use Gemini's best available model (gemini-1.5-pro or newer)
3. WHEN Gemini API is unavailable, THE RAG_Service SHALL fall back to extractive answer mode
4. THE RAG_Service SHALL pass retrieved context chunks to Gemini with proper formatting
5. THE RAG_Service SHALL instruct Gemini to cite page numbers in its responses
6. WHEN GEMINI_API_KEY is not configured, THE System SHALL operate in extractive mode without attempting Gemini calls
