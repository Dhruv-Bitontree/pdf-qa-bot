import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { authenticate } from "../middleware/auth.js";
import { processDocument } from "../services/pdf-processor.js";
import { deleteDocumentVectors } from "../services/vector-store.js";
import { generateEmbeddings } from "../services/embedding-generator.js";
import { upsertVectors } from "../services/vector-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, "..", "..", "uploads");
const extractedImagesDir = path.join(uploadsDir, "extracted-images");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

export function createDocumentRoutes(db) {
  const router = Router();
  router.use(authenticate);

  // List documents
  router.get("/", (req, res) => {
    const rawQ = String(req.query.q || "").trim();
    const q = rawQ.toLowerCase();
    const rawPage = req.query.page;
    const rawPageSize = req.query.pageSize;
    const hasAdvancedQuery =
      rawQ.length > 0 || rawPage !== undefined || rawPageSize !== undefined;

    // Backward-compatible response for old callers/tests.
    if (!hasAdvancedQuery) {
      const docs = db
        .prepare(
          "SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC",
        )
        .all(req.user.id);
      res.json(docs);
      return;
    }

    const page = Math.max(1, parseInt(String(rawPage || "1"), 10) || 1);
    const pageSize = Math.min(
      50,
      Math.max(1, parseInt(String(rawPageSize || "5"), 10) || 5),
    );
    const offset = (page - 1) * pageSize;

    const whereParts = ["user_id = ?"];
    const whereParams = [req.user.id];
    if (q.length > 0) {
      whereParts.push(
        "(LOWER(original_name) LIKE ? OR LOWER(COALESCE(ai_title_short, '')) LIKE ? OR LOWER(COALESCE(ai_summary, '')) LIKE ?)",
      );
      const pattern = `%${q}%`;
      whereParams.push(pattern, pattern, pattern);
    }

    const whereClause = whereParts.join(" AND ");
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS total FROM documents WHERE ${whereClause}`)
      .get(...whereParams);
    const total = Number(totalRow?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const docs = db
      .prepare(
        `SELECT * FROM documents
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...whereParams, pageSize, offset);

    res.json({
      items: docs,
      page,
      pageSize,
      total,
      totalPages,
      query: rawQ,
    });
  });

  // Upload document
  router.post("/", upload.single("file"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file uploaded" });
    }

    try {
      const stmt = db.prepare(
        "INSERT INTO documents (user_id, filename, original_name, file_size) VALUES (?, ?, ?, ?)",
      );
      const info = stmt.run(
        req.user.id,
        req.file.filename,
        req.file.originalname,
        req.file.size,
      );

      if (!info || !info.lastInsertRowid) {
        console.error("Failed to get lastInsertRowid from insert");
        return res
          .status(500)
          .json({ error: "Failed to create document record" });
      }

      const doc = db
        .prepare("SELECT * FROM documents WHERE id = ?")
        .get(info.lastInsertRowid);

      if (!doc) {
        console.error("Failed to retrieve inserted document");
        return res.status(500).json({ error: "Failed to retrieve document" });
      }

      // Process PDF asynchronously
      processDocument(
        db,
        doc.id,
        path.join(uploadsDir, req.file.filename),
      ).catch((err) => {
        console.error(`Error processing document ${doc.id}:`, err);
        db.prepare("UPDATE documents SET status = 'error' WHERE id = ?").run(
          doc.id,
        );
      });

      res.status(201).json(doc);
    } catch (err) {
      console.error("Document upload error:", err);
      res.status(500).json({ error: "Failed to upload document" });
    }
  });

  // Get single document
  router.get("/:id", (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    res.json(doc);
  });

  // Get document processing progress
  router.get("/:id/progress", (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const safeTotal = Number(doc.chunks_total || 0);
    const safeProcessed = Number(doc.chunks_processed || 0);

    res.json({
      document_id: Number(doc.id),
      status: doc.status,
      stage: doc.processing_stage || null,
      status_message: doc.status_message || null,
      chunks_total: safeTotal,
      chunks_processed: safeProcessed,
      extracted_image_count: Number(doc.extracted_image_count || 0),
      progress_percent:
        Math.round(Number(doc.progress_percent || 0) * 100) / 100,
    });
  });

  // List extracted images for a document
  router.get("/:id/images", (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const images = db
      .prepare(
        `SELECT id, document_id, page_number, image_path, mime_type, width, height, file_size, source_type, context_text, created_at
         FROM extracted_images
         WHERE document_id = ?
         ORDER BY page_number ASC, id ASC`,
      )
      .all(doc.id)
      .map((img) => ({
        ...img,
        preview_url: `/documents/${doc.id}/images/${img.id}/preview`,
        download_url: `/documents/${doc.id}/images/${img.id}/download`,
      }));

    res.json(images);
  });

  // Preview extracted image inline
  router.get("/:id/images/:imageId/preview", (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const image = db
      .prepare(
        `SELECT id, image_path, mime_type
         FROM extracted_images
         WHERE id = ? AND document_id = ?`,
      )
      .get(req.params.imageId, doc.id);

    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }

    const imagePath = path.join(extractedImagesDir, image.image_path);
    if (!fs.existsSync(imagePath)) {
      return res.status(404).json({ error: "Image file missing on disk" });
    }

    res.setHeader("Content-Type", image.mime_type || "image/png");
    res.setHeader("Content-Disposition", "inline");
    fs.createReadStream(imagePath).pipe(res);
  });

  // Download extracted image
  router.get("/:id/images/:imageId/download", (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const image = db
      .prepare(
        `SELECT id, document_id, page_number, image_path, mime_type
         FROM extracted_images
         WHERE id = ? AND document_id = ?`,
      )
      .get(req.params.imageId, doc.id);

    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }

    const imagePath = path.join(extractedImagesDir, image.image_path);
    if (!fs.existsSync(imagePath)) {
      return res.status(404).json({ error: "Image file missing on disk" });
    }

    res.setHeader("Content-Type", image.mime_type || "image/png");
    const pageLabel = image.page_number ? `-page-${image.page_number}` : "";
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="document-${doc.id}${pageLabel}-image-${image.id}.png"`,
    );
    fs.createReadStream(imagePath).pipe(res);
  });

  // Serve PDF file
  router.get("/:id/file", (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const filePath = path.join(uploadsDir, doc.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found on disk" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${doc.original_name}"`,
    );
    fs.createReadStream(filePath).pipe(res);
  });

  // Get chunks for a document
  router.get("/:id/chunks", (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const chunks = db
      .prepare(
        "SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index",
      )
      .all(doc.id);
    res.json(chunks);
  });

  // Delete document
  router.delete("/:id", async (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    // Try to delete vectors from Pinecone (best effort)
    try {
      await deleteDocumentVectors(doc.id);
    } catch (err) {
      console.error(
        `Failed to delete vectors for document ${doc.id}:`,
        err.message,
      );
      // Continue with database deletion even if Pinecone cleanup fails
    }

    // Delete file from disk
    const filePath = path.join(uploadsDir, doc.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    const images = db
      .prepare("SELECT image_path FROM extracted_images WHERE document_id = ?")
      .all(doc.id);

    for (const image of images) {
      const imagePath = path.join(extractedImagesDir, image.image_path);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
    res.json({ message: "Document deleted" });
  });

  // Reindex document embeddings
  router.post("/:id/reindex", async (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);

    if (!doc) return res.status(404).json({ error: "Document not found" });

    try {
      // Get all chunks for the document
      const chunks = db
        .prepare(
          "SELECT id, content, page_number FROM chunks WHERE document_id = ? ORDER BY chunk_index",
        )
        .all(doc.id);

      if (chunks.length === 0) {
        return res.json({
          document_id: doc.id,
          chunks_processed: 0,
          embeddings_generated: 0,
          status: "success",
          message: "No chunks to reindex",
        });
      }

      // Delete existing embeddings
      try {
        await deleteDocumentVectors(doc.id);
      } catch (err) {
        console.error(
          `Failed to delete old embeddings for document ${doc.id}:`,
          err.message,
        );
        // Continue anyway
      }

      // Generate new embeddings
      const chunkTexts = chunks.map((c) => c.content);
      const embeddings = await generateEmbeddings(chunkTexts);

      // Prepare vectors
      const vectors = chunks.map((chunk, i) => ({
        id: `chunk_${chunk.id}`,
        embedding: embeddings[i],
        metadata: {
          document_id: doc.id,
          chunk_id: chunk.id,
          page_number: chunk.page_number || 1,
          content_preview: chunk.content.slice(0, 500),
        },
      }));

      // Upsert to Pinecone
      await upsertVectors(vectors);

      res.json({
        document_id: doc.id,
        chunks_processed: chunks.length,
        embeddings_generated: embeddings.length,
        status: "success",
        message: `Successfully reindexed ${chunks.length} chunks`,
      });
    } catch (err) {
      console.error(`Reindex failed for document ${doc.id}:`, err.message);
      res.status(500).json({
        document_id: doc.id,
        status: "failed",
        message: err.message,
      });
    }
  });

  return router;
}
