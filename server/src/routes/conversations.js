import { Router } from "express";
import { authenticate } from "../middleware/auth.js";

export function createConversationRoutes(db) {
  const router = Router();
  router.use(authenticate);

  // List conversations for a document
  router.get("/document/:documentId", (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.documentId, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const conversations = db
      .prepare(
        `
        SELECT
          c.*,
          COUNT(m.id) AS message_count,
          MAX(m.created_at) AS last_message_at
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.document_id = ? AND c.user_id = ?
        GROUP BY c.id
        ORDER BY
          CASE WHEN MAX(m.created_at) IS NULL THEN c.created_at ELSE MAX(m.created_at) END DESC,
          c.id DESC
      `,
      )
      .all(doc.id, req.user.id);
    res.json(conversations);
  });

  // Create conversation for a document
  router.post("/document/:documentId", (req, res) => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(req.params.documentId, req.user.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const title = req.body.title || "New Conversation";
    const stmt = db.prepare(
      "INSERT INTO conversations (user_id, document_id, title) VALUES (?, ?, ?)",
    );
    const info = stmt.run(req.user.id, doc.id, title);
    const conversation = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(info.lastInsertRowid);
    res.status(201).json(conversation);
  });

  // Get messages for a conversation
  router.get("/:id/messages", (req, res) => {
    const conv = db
      .prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const limitRaw = Number.parseInt(String(req.query.limit || ""), 10);
    const hasLimit = Number.isFinite(limitRaw) && limitRaw > 0;

    const messages = hasLimit
      ? db
          .prepare(
            `SELECT * FROM messages
             WHERE conversation_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(conv.id, limitRaw)
          .reverse()
      : db
          .prepare(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
          )
          .all(conv.id);

    // Parse persisted JSON payloads
    const parsed = messages.map((m) => ({
      ...m,
      sources: m.sources ? JSON.parse(m.sources) : null,
      images: m.images ? JSON.parse(m.images) : [],
    }));

    res.json(parsed);
  });

  return router;
}
