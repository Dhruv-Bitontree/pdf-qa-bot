import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../middleware/auth.js';
import { processDocument } from '../services/pdf-processor.js';

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

    const stmt = db.prepare(
      'INSERT INTO documents (user_id, filename, original_name, file_size) VALUES (?, ?, ?, ?)'
    );
    const info = stmt.run(req.user.id, req.file.filename, req.file.originalname, req.file.size);

    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid);

    // Process PDF asynchronously
    processDocument(db, doc.id, path.join(uploadsDir, req.file.filename)).catch((err) => {
      console.error(`Error processing document ${doc.id}:`, err);
      db.prepare("UPDATE documents SET status = 'error' WHERE id = ?").run(doc.id);
    });

    res.status(201).json(doc);
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
  router.delete('/:id', (req, res) => {
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Delete file from disk
    const filePath = path.join(uploadsDir, doc.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    res.json({ message: 'Document deleted' });
  });

  return router;
}
