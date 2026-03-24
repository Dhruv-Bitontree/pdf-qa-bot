import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, chunkDocument } from '../services/chunker.js';

describe('Chunker', () => {
  it('should chunk text into pieces', () => {
    const text = 'This is a test sentence. Another sentence here. And a third one. Plus more content to make this longer. Final sentence in the text.';
    const chunks = chunkText(text, 1, { chunkSize: 60, overlap: 20 });

    assert.ok(chunks.length > 1, 'Should create multiple chunks');
    assert.ok(chunks.every((c) => c.page_number === 1));
    assert.ok(chunks.every((c) => c.content.length > 0));
  });

  it('should respect page numbers', () => {
    const chunks = chunkText('Hello world.', 5);
    assert.equal(chunks[0].page_number, 5);
  });

  it('should track offsets', () => {
    const text = 'First sentence here. Second sentence there. Third one follows.';
    const chunks = chunkText(text, 1, { chunkSize: 30, overlap: 5 });

    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0].start_offset, 0);
    assert.ok(chunks[0].end_offset > 0);
  });

  it('should handle empty text', () => {
    const chunks = chunkText('', 1);
    assert.equal(chunks.length, 0);
  });

  it('should handle very short text', () => {
    const chunks = chunkText('Short.', 1);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, 'Short.');
  });

  it('should chunk multiple pages', () => {
    const pages = [
      { pageNumber: 1, text: 'Page one content here with enough text to form a chunk.' },
      { pageNumber: 2, text: 'Page two content here with enough text to form a chunk.' },
    ];
    const chunks = chunkDocument(pages);

    assert.ok(chunks.length >= 2);
    assert.ok(chunks.some((c) => c.page_number === 1));
    assert.ok(chunks.some((c) => c.page_number === 2));
    // chunk_index should be sequential
    chunks.forEach((c, i) => assert.equal(c.chunk_index, i));
  });
});
