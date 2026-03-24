import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../middleware/auth.js';
import { processDocument } from '../services/pdf-processor.js';
import { deleteDocumentVectors } from '../services/vector-store.js';
import { generateEmbeddings } from '../services/embedding-generator.js';
import { upsertVectors } from '../services/vector-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

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
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

export function createDocumentRoutes(db) {
  const router = Router();
  router.use(authenticate);

  // List documents
  router.get('/', (req, res) => {
    const docs = db
      .prepare('SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.user.id);
    res.json(docs);
  });

  // Upload document
  router.post('/', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    try {
      const stmt = db.prepare(
        'INSERT INTO documents (user_id, filename, original_name, file_size) VALUES (?, ?, ?, ?)'
      );
      const info = stmt.run(req.user.id, req.file.filename, req.file.originalname, req.file.size);
      
      if (!info || !info.lastInsertRowid) {
        console.error('Failed to get lastInsertRowid from insert');
        return res.status(500).json({ error: 'Failed to create document record' });
      }

      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid);
      
      if (!doc) {
        console.error('Failed to retrieve inserted document');
        return res.status(500).json({ error: 'Failed to retrieve document' });
      }

      // Process PDF asynchronously
      processDocument(db, doc.id, path.join(uploadsDir, req.file.filename)).catch((err) => {
        console.error(`Error processing document ${doc.id}:`, err);
        db.prepare("UPDATE documents SET status = 'error' WHERE id = ?").run(doc.id);
      });

      res.status(201).json(doc);
    } catch (err) {
      console.error('Document upload error:', err);
      res.status(500).json({ error: 'Failed to upload document' });
    }
  });

  // Get single document
  router.get('/:id', (req, res) => {
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  });

  // Serve PDF file
  router.get('/:id/file', (req, res) => {
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const filePath = path.join(uploadsDir, doc.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.original_name}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  // Get chunks for a document
  router.get('/:id/chunks', (req, res) => {
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const chunks = db
      .prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(doc.id);
    res.json(chunks);
  });

  // Delete document
  router.delete('/:id', async (req, res) => {
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Try to delete vectors from Pinecone (best effort)
    try {
      await deleteDocumentVectors(doc.id);
    } catch (err) {
      console.error(`Failed to delete vectors for document ${doc.id}:`, err.message);
      // Continue with database deletion even if Pinecone cleanup fails
    }

    // Delete file from disk
    const filePath = path.join(uploadsDir, doc.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    res.json({ message: 'Document deleted' });
  });

  // Reindex document embeddings
  router.post('/:id/reindex', async (req, res) => {
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    try {
      // Get all chunks for the document
      const chunks = db
        .prepare('SELECT id, content, page_number FROM chunks WHERE document_id = ? ORDER BY chunk_index')
        .all(doc.id);

      if (chunks.length === 0) {
        return res.json({
          document_id: doc.id,
          chunks_processed: 0,
          embeddings_generated: 0,
          status: 'success',
          message: 'No chunks to reindex'
        });
      }

      // Delete existing embeddings
      try {
        await deleteDocumentVectors(doc.id);
      } catch (err) {
        console.error(`Failed to delete old embeddings for document ${doc.id}:`, err.message);
        // Continue anyway
      }

      // Generate new embeddings
      const chunkTexts = chunks.map(c => c.content);
      const embeddings = await generateEmbeddings(chunkTexts);

      // Prepare vectors
      const vectors = chunks.map((chunk, i) => ({
        id: `chunk_${chunk.id}`,
        embedding: embeddings[i],
        metadata: {
          document_id: doc.id,
          chunk_id: chunk.id,
          page_number: chunk.page_number || 1,
          content_preview: chunk.content.slice(0, 500)
        }
      }));

      // Upsert to Pinecone
      await upsertVectors(vectors);

      res.json({
        document_id: doc.id,
        chunks_processed: chunks.length,
        embeddings_generated: embeddings.length,
        status: 'success',
        message: `Successfully reindexed ${chunks.length} chunks`
      });

    } catch (err) {
      console.error(`Reindex failed for document ${doc.id}:`, err.message);
      res.status(500).json({
        document_id: doc.id,
        status: 'failed',
        message: err.message
      });
    }
  });

  return router;
}
