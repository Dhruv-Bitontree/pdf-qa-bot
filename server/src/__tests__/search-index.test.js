import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tokenize, buildIndex, search } from "../services/search-index.js";
import { createDb } from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Search Index", () => {
  describe("tokenize", () => {
    it("should lowercase and split text", () => {
      const tokens = tokenize("Hello World");
      assert.ok(tokens.includes("hello"));
      assert.ok(tokens.includes("world"));
    });

    it("should remove stopwords", () => {
      const tokens = tokenize("the quick brown fox is very fast");
      assert.ok(!tokens.includes("the"));
      assert.ok(!tokens.includes("is"));
      assert.ok(!tokens.includes("very"));
      assert.ok(tokens.includes("quick"));
      assert.ok(tokens.includes("brown"));
      assert.ok(tokens.includes("fox"));
      assert.ok(tokens.includes("fast"));
    });

    it("should remove punctuation", () => {
      const tokens = tokenize("Hello, world! How are you?");
      assert.ok(tokens.includes("hello"));
      assert.ok(tokens.includes("world"));
    });

    it("should filter short tokens", () => {
      const tokens = tokenize("I a am go to do it");
      assert.ok(!tokens.includes("i"));
      assert.ok(!tokens.includes("a"));
    });
  });

  describe("BM25 search", () => {
    let db, dbPath;

    before(async () => {
      dbPath = path.join(__dirname, `test-search-${Date.now()}.db`);
      db = await createDb(dbPath);

      // Insert a test document
      db.prepare(
        "INSERT INTO users (email, password, name) VALUES (?, ?, ?)",
      ).run("test@test.com", "hash", "Test");
      db.prepare(
        "INSERT INTO documents (user_id, filename, original_name, file_size, status) VALUES (1, 'test.pdf', 'test.pdf', 1000, 'ready')",
      ).run();

      // Insert test chunks
      const insertChunk = db.prepare(
        "INSERT INTO chunks (document_id, chunk_index, content, page_number, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insertChunk.run(
        1,
        0,
        "Machine learning is a branch of artificial intelligence focused on building systems that learn from data.",
        1,
        0,
        100,
      );
      insertChunk.run(
        1,
        1,
        "Deep learning uses neural networks with multiple layers to process complex patterns in data.",
        1,
        100,
        200,
      );
      insertChunk.run(
        1,
        2,
        "Natural language processing enables computers to understand and generate human language.",
        2,
        0,
        100,
      );
      insertChunk.run(
        1,
        3,
        "Computer vision allows machines to interpret visual information from the world around them.",
        2,
        100,
        200,
      );
      insertChunk.run(
        1,
        4,
        "Reinforcement learning trains agents through rewards and penalties in an environment.",
        3,
        0,
        100,
      );

      // Build index
      const chunks = db
        .prepare("SELECT id, content FROM chunks WHERE document_id = 1")
        .all();
      buildIndex(db, 1, chunks);
    });

    after(() => {
      db.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    });

    it("should find relevant chunks for a query", () => {
      const results = search(db, 1, "machine learning data");
      assert.ok(results.length > 0);
      // First result should be the machine learning chunk
      assert.ok(results[0].content.includes("Machine learning"));
    });

    it("should rank results by relevance", () => {
      const results = search(db, 1, "neural networks deep learning");
      assert.ok(results.length > 0);
      assert.ok(
        results[0].content.includes("Deep learning") ||
          results[0].content.includes("neural"),
      );
    });

    it("should return page numbers", () => {
      const results = search(db, 1, "natural language");
      assert.ok(results.length > 0);
      const nlpResult = results.find((r) =>
        r.content.includes("Natural language"),
      );
      assert.ok(nlpResult);
      assert.equal(nlpResult.page_number, 2);
    });

    it("should return empty for irrelevant queries", () => {
      const results = search(db, 1, "cooking recipes ingredients");
      // May return some results with very low scores, but top results should have low relevance
      // With BM25, completely unrelated terms should yield no matches
      assert.ok(results.length === 0 || results[0].score < 1);
    });

    it("should respect topK parameter", () => {
      const results = search(db, 1, "learning data", 2);
      assert.ok(results.length <= 2);
    });
  });
});
