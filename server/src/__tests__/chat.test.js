import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { createDb } from '../db.js';
import { buildIndex } from '../services/search-index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Chat API', () => {
  let app, db, dbPath, token, conversationId;

  before(async () => {
    dbPath = path.join(__dirname, `test-chat-${Date.now()}.db`);
    db = createDb(dbPath);
    app = createApp(db);

    // Register user
    const authRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'chat@example.com', password: 'password123', name: 'Chat Tester' });
    token = authRes.body.token;
    const userId = authRes.body.user.id;

    // Create a document directly in DB (skip file upload for unit test)
    db.prepare(
      "INSERT INTO documents (user_id, filename, original_name, file_size, status, page_count) VALUES (?, 'test.pdf', 'test.pdf', 1000, 'ready', 2)"
    ).run(userId);

    // Insert chunks
    const insertChunk = db.prepare(
      'INSERT INTO chunks (document_id, chunk_index, content, page_number, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insertChunk.run(1, 0, 'The capital of France is Paris. Paris is known for the Eiffel Tower.', 1, 0, 70);
    insertChunk.run(1, 1, 'Python is a popular programming language used for web development and data science.', 1, 70, 150);
    insertChunk.run(1, 2, 'The Louvre Museum in Paris houses the Mona Lisa painting by Leonardo da Vinci.', 2, 0, 80);

    // Build search index
    const chunks = db.prepare('SELECT id, content FROM chunks WHERE document_id = 1').all();
    buildIndex(db, 1, chunks);

    // Create conversation
    const convRes = await request(app)
      .post('/api/conversations/document/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Test Chat' });
    conversationId = convRes.body.id;
  });

  after(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('should send a message and get a response', async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'What is the capital of France?' });

    assert.equal(res.status, 200);
    assert.ok(res.body.userMessage);
    assert.ok(res.body.assistantMessage);
    assert.equal(res.body.userMessage.role, 'user');
    assert.equal(res.body.assistantMessage.role, 'assistant');
  });

  it('should return sources with the response', async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Tell me about Paris' });

    assert.equal(res.status, 200);
    assert.ok(res.body.assistantMessage.sources);
    assert.ok(Array.isArray(res.body.assistantMessage.sources));
    assert.ok(res.body.assistantMessage.sources.length > 0);

    // Sources should have page numbers
    const source = res.body.assistantMessage.sources[0];
    assert.ok(source.page_number);
    assert.ok(source.snippet);
  });

  it('should persist messages in conversation', async () => {
    const msgRes = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(msgRes.status, 200);
    assert.ok(msgRes.body.length >= 4); // 2 user + 2 assistant from previous tests
  });

  it('should reject empty messages', async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '' });

    assert.equal(res.status, 400);
  });

  it('should reject unauthorized access', async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/chat`)
      .send({ message: 'test' });

    assert.equal(res.status, 401);
  });
});
