import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';

export function createConversationRoutes(db) {
  const router = Router();
  router.use(authenticate);

  // List conversations for a document
  router.get('/document/:documentId', (req, res) => {
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.documentId, req.user.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const conversations = db
      .prepare('SELECT * FROM conversations WHERE document_id = ? AND user_id = ? ORDER BY created_at DESC')
      .all(doc.id, req.user.id);
    res.json(conversations);
  });

  // Create conversation for a document
  router.post('/document/:documentId', (req, res) => {
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.documentId, req.user.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const title = req.body.title || 'New Conversation';
    const stmt = db.prepare(
      'INSERT INTO conversations (user_id, document_id, title) VALUES (?, ?, ?)'
    );
    const info = stmt.run(req.user.id, doc.id, title);
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(conversation);
  });

  // Get messages for a conversation
  router.get('/:id/messages', (req, res) => {
    const conv = db
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const messages = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conv.id);

    // Parse sources JSON
    const parsed = messages.map((m) => ({
      ...m,
      sources: m.sources ? JSON.parse(m.sources) : null,
    }));

    res.json(parsed);
  });

  return router;
}
