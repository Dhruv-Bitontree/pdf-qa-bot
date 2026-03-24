import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAuthRoutes } from './routes/auth.js';
import { createDocumentRoutes } from './routes/documents.js';
import { createConversationRoutes } from './routes/conversations.js';
import { createChatRoutes } from './routes/chat.js';
import { createSearchRoutes } from './routes/search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Routes
  app.use('/api/auth', createAuthRoutes(db));
  app.use('/api/documents', createDocumentRoutes(db));
  app.use('/api/conversations', createConversationRoutes(db));
  app.use('/api/search', createSearchRoutes());
  app.use('/api', createChatRoutes(db));

  // Error handler
  app.use((err, req, res, next) => {
    console.error(err.stack);
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Internal server error',
    });
  });

  return app;
}
