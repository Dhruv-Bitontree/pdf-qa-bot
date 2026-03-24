import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { generateAnswer } from '../services/rag.js';

export function createChatRoutes(db) {
  const router = Router();

  // Send message and get RAG response
  router.post('/conversations/:id/chat', authenticate, async (req, res, next) => {
    try {
      const conv = db
        .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
        .get(req.params.id, req.user.id);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });

      const { message } = req.body;
      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
      }

      const result = await generateAnswer(db, conv.id, conv.document_id, message.trim());
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
