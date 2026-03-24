import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../app.js";
import { createDb } from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Documents API", () => {
  let app, db, dbPath, token;

  before(async () => {
    dbPath = path.join(__dirname, `test-docs-${Date.now()}.db`);
    db = await createDb(dbPath);
    app = createApp(db);

    // Register a user
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: "doctest@example.com",
        password: "password123",
        name: "Doc Tester",
      });
    token = res.body.token;
  });

  after(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it("should return empty document list", async () => {
    const res = await request(app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0);
  });

  it("should require authentication", async () => {
    const res = await request(app).get("/api/documents");
    assert.equal(res.status, 401);
  });

  it("should reject non-PDF files", async () => {
    const res = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("not a pdf"), {
        filename: "test.txt",
        contentType: "text/plain",
      });

    assert.equal(res.status, 500); // multer rejects with error
  });

  it("should upload a PDF", async () => {
    // Create a minimal valid PDF
    const pdfContent = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
206
%%EOF`;

    const res = await request(app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(pdfContent), {
        filename: "test.pdf",
        contentType: "application/pdf",
      });

    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.original_name, "test.pdf");
    assert.equal(res.body.status, "processing");
  });

  it("should list uploaded documents", async () => {
    const res = await request(app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 1);
  });

  it("should get a single document", async () => {
    const listRes = await request(app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${token}`);

    const docId = listRes.body[0].id;
    const res = await request(app)
      .get(`/api/documents/${docId}`)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.id, docId);
  });

  it("should return 404 for non-existent document", async () => {
    const res = await request(app)
      .get("/api/documents/99999")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 404);
  });
});
