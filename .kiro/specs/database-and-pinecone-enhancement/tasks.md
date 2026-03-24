# Implementation Plan: Database and Pinecone Enhancement

## Overview

This implementation plan migrates the PDF Q&A Bot from sql.js to better-sqlite3, integrates Pinecone vector search with OpenRouter embeddings, implements hybrid search with RRF, and adds Gemini-powered answer generation via Langchain. The implementation is structured to build incrementally, with each task validating functionality before proceeding.

## Tasks

- [x] 1. Migrate database from sql.js to better-sqlite3
  - Replace sql.js initialization with better-sqlite3 in db.js
  - Update database connection to use synchronous better-sqlite3 API
  - Remove manual save operations (better-sqlite3 auto-saves)
  - Enable foreign key constraints with PRAGMA
  - Update prepare/run/all method calls to use native better-sqlite3 API
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [ ]* 1.1 Write unit tests for database migration
  - Test foreign key constraint enforcement
  - Test transaction handling with foreign keys
  - Test schema compatibility
  - _Requirements: 1.2, 1.3, 1.4, 9.1_

- [x] 2. Implement embedding generation service with OpenRouter
  - [x] 2.1 Create embedding-generator.js service
    - Implement generateEmbedding() for single text
    - Implement generateEmbeddings() for batch processing (max 100 per request)
    - Use OpenRouter API with openai/text-embedding-3-large model
    - Add retry logic with exponential backoff (3 attempts, 1s/2s/4s delays)
    - Handle rate limiting (429 errors) with backoff
    - Add 30-second timeout per request
    - _Requirements: 2.1, 2.3, 2.4, 10.1_

  - [ ]* 2.2 Write property test for embedding dimensions
    - **Property 2: Embedding Dimension Consistency**
    - **Validates: Requirements 2.1**

  - [ ]* 2.3 Write property test for batch size limits
    - **Property 3: Embedding Batch Size Limit**
    - **Validates: Requirements 2.4, 10.1**

  - [ ]* 2.4 Write unit tests for embedding error handling
    - Test OpenRouter API unavailable scenario
    - Test rate limiting with retry logic
    - Test network errors with exponential backoff
    - _Requirements: 2.2, 2.3, 2.5, 7.2, 7.3, 9.2_

- [x] 3. Implement Pinecone vector store manager
  - [x] 3.1 Create vector-store.js service
    - Implement initPinecone() to initialize Pinecone client
    - Implement upsertVectors() with batching (100 vectors per request)
    - Implement searchVectors() for similarity search
    - Implement deleteVectors() for cleanup by IDs
    - Implement deleteDocumentVectors() for document-level cleanup
    - Implement checkStatus() for connection verification
    - Use chunk_id as vector ID format: "chunk_{id}"
    - Limit content_preview metadata to 500 characters
    - _Requirements: 3.1, 3.3, 3.4, 8.3, 10.2_

  - [ ]* 3.2 Write property test for metadata completeness
    - **Property 4: Vector Metadata Completeness**
    - **Validates: Requirements 3.1**

  - [ ]* 3.3 Write property test for content preview truncation
    - **Property 5: Content Preview Truncation**
    - **Validates: Requirements 3.4**

  - [ ]* 3.4 Write property test for vector ID format
    - **Property 8: Vector ID Format**
    - **Validates: Requirements 8.3**

  - [ ]* 3.5 Write property test for batch upsert size
    - **Property 14: Vector Batch Upsert Size**
    - **Validates: Requirements 10.2**

  - [ ]* 3.6 Write unit tests for Pinecone error handling
    - Test operation when Pinecone not configured
    - Test Pinecone API failures with fallback
    - Test connection status checking
    - _Requirements: 3.2, 3.5, 9.3_

- [ ] 4. Checkpoint - Verify database and vector services
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement hybrid search with RRF
  - [x] 5.1 Create hybrid-search.js service
    - Implement reciprocalRankFusion() algorithm (k=60)
    - Implement hybridSearch() supporting three modes: bm25, pinecone, hybrid
    - Add score normalization to [0, 1] range
    - Implement fallback to BM25 when Pinecone unavailable
    - Respect top-k parameter for result count
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 5.2 Write property test for RRF algorithm
    - **Property 10: RRF Score Calculation**
    - **Validates: Requirements 4.2**

  - [ ]* 5.3 Write property test for score normalization
    - **Property 11: Score Normalization Range**
    - **Validates: Requirements 4.5**

  - [ ]* 5.4 Write property test for top-k result count
    - **Property 12: Top-K Result Count**
    - **Validates: Requirements 4.6**

  - [ ]* 5.5 Write property test for hybrid search source usage
    - **Property 9: Hybrid Search Source Usage**
    - **Validates: Requirements 4.1**

  - [ ]* 5.6 Write unit tests for search modes
    - Test bm25-only mode
    - Test pinecone-only mode
    - Test hybrid mode
    - Test fallback when Pinecone unavailable
    - _Requirements: 4.3, 4.4, 9.4, 9.5_

- [x] 6. Update PDF processor to generate embeddings
  - [x] 6.1 Modify pdf-processor.js to integrate embedding generation
    - Import embedding-generator and vector-store services
    - After inserting chunks, extract chunk texts
    - Generate embeddings for all chunks in batches
    - Prepare vectors with metadata (document_id, chunk_id, page_number, content_preview)
    - Upsert vectors to Pinecone with error handling
    - Ensure document is marked "ready" even if embedding fails
    - Log processing progress for documents with >50 chunks
    - _Requirements: 6.3, 7.6, 10.3, 10.5_

  - [ ]* 6.2 Write property test for document upload resilience
    - **Property 13: Document Upload Resilience**
    - **Validates: Requirements 6.3, 7.6**

  - [ ]* 6.3 Write property test for foreign key enforcement
    - **Property 1: Foreign Key Constraint Enforcement**
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 6.4 Write unit test for async embedding generation
    - Test that upload response returns before embeddings complete
    - _Requirements: 10.3_

- [x] 7. Implement Gemini answer generation with Langchain
  - [x] 7.1 Update rag.js to use Gemini via Langchain
    - Install @langchain/google-genai and langchain packages
    - Initialize ChatGoogleGenerativeAI with gemini-1.5-pro model
    - Replace existing LLM call with Gemini invocation
    - Format context with page references for Gemini
    - Add system prompt instructing Gemini to cite page numbers
    - Implement fallback to extractive mode on Gemini failure
    - Handle case when GEMINI_API_KEY not configured
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [ ]* 7.2 Write unit tests for Gemini integration
    - Test answer generation with mocked Gemini responses
    - Test fallback to extractive mode when Gemini unavailable
    - Test operation without GEMINI_API_KEY configured
    - _Requirements: 11.3, 11.6_

- [x] 8. Update RAG service to use hybrid search
  - [x] 8.1 Modify rag.js to use hybrid search
    - Import hybrid-search service
    - Replace direct search() call with hybridSearch()
    - Read SEARCH_MODE from environment (default: hybrid)
    - Pass search mode to hybridSearch()
    - _Requirements: 4.1, 5.3, 5.4_

  - [ ]* 8.2 Write integration test for hybrid search in RAG
    - Test end-to-end question answering with hybrid search
    - Verify both BM25 and Pinecone results are merged
    - _Requirements: 9.5_

- [ ] 9. Checkpoint - Verify search and RAG integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement document deletion with vector cleanup
  - [x] 10.1 Update documents.js DELETE endpoint
    - Add call to deleteDocumentVectors() before database deletion
    - Wrap Pinecone deletion in try-catch (best effort)
    - Log errors but continue with database deletion
    - Ensure document deletion always succeeds
    - _Requirements: 3.6, 8.1, 8.5_

  - [ ]* 10.2 Write property test for document deletion cleanup
    - **Property 6: Document Deletion Cleanup**
    - **Validates: Requirements 3.6, 8.1**

  - [ ]* 10.3 Write property test for chunk deletion cleanup
    - **Property 7: Chunk Deletion Cleanup**
    - **Validates: Requirements 8.2**

  - [ ]* 10.4 Write unit test for deletion error handling
    - Test document deletion succeeds when Pinecone deletion fails
    - _Requirements: 8.5_

- [x] 11. Add search status endpoint
  - [x] 11.1 Create GET /api/search/status endpoint
    - Check Pinecone configuration and connection
    - Return current search mode from environment
    - Include embedding model and provider info
    - Include LLM model and provider info
    - Indicate degraded mode if Pinecone configured but unavailable
    - _Requirements: 6.1, 6.5_

  - [ ]* 11.2 Write unit test for status endpoint
    - Test response structure includes all required fields
    - Test degraded mode indication
    - _Requirements: 6.5_

- [x] 12. Add document reindex endpoint
  - [x] 12.1 Create POST /api/documents/:id/reindex endpoint
    - Verify document exists and user has access
    - Retrieve all chunks for the document
    - Delete existing embeddings from Pinecone
    - Generate new embeddings for all chunks
    - Upsert new vectors to Pinecone
    - Return status with counts (chunks_processed, embeddings_generated)
    - Handle partial failures gracefully
    - _Requirements: 6.2, 6.4, 8.4_

  - [ ]* 12.2 Write unit test for reindex endpoint
    - Test reindexing deletes old embeddings before creating new ones
    - Test partial failure handling
    - _Requirements: 6.4, 8.4_

- [x] 13. Update environment configuration
  - [x] 13.1 Update .env.example with new variables
    - Add OPENROUTER_API_KEY with description
    - Add GEMINI_API_KEY with description
    - Add PINECONE_API_KEY with description
    - Add PINECONE_INDEX_NAME with description
    - Add SEARCH_MODE with valid values and default
    - Remove or update OPENAI_API_KEY description
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 5.7_

  - [ ]* 13.2 Write unit tests for environment configuration
    - Test default SEARCH_MODE is hybrid
    - Test BM25-only mode when PINECONE_API_KEY not provided
    - Test configuration reading for all new variables
    - _Requirements: 5.4, 5.5_

- [x] 14. Update package dependencies
  - [x] 14.1 Update server/package.json
    - Add better-sqlite3 dependency
    - Add @pinecone-database/pinecone dependency
    - Add @langchain/google-genai dependency
    - Add langchain dependency
    - Remove sql.js dependency
    - Run npm install in server directory
    - _Requirements: 1.1, 3.1, 11.1_

- [ ] 15. Checkpoint - Run all tests and verify functionality
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Integration testing and validation
  - [ ]* 16.1 Write end-to-end integration tests
    - Test complete document upload with embedding generation
    - Test hybrid search with real database and mocked APIs
    - Test document deletion with vector cleanup
    - Test reindex endpoint functionality
    - Test graceful degradation scenarios
    - _Requirements: 9.5, 9.6_

  - [ ]* 16.2 Verify existing tests still pass
    - Run all existing test suites
    - Fix any breaking changes
    - _Requirements: 9.7_

- [ ] 17. Final checkpoint - Complete system verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test-related sub-tasks and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests validate universal correctness properties across randomized inputs
- Unit tests validate specific examples, edge cases, and error conditions
- The implementation maintains backward compatibility with existing APIs
- All external service failures are handled gracefully with fallback mechanisms
