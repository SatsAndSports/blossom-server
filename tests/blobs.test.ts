import { test, describe, expect } from './fixtures';
import { createHash, randomBytes } from 'crypto';

// Generate unique blob content for each test to avoid collisions
function generateBlob(): { content: Buffer; hash: string } {
  const content = Buffer.from(`test-blob-${randomBytes(16).toString('hex')}`);
  const hash = createHash('sha256').update(content).digest('hex');
  return { content, hash };
}

describe('Blob operations', () => {
  test('PUT uploads a blob and returns its hash', async ({ server }) => {
    const { content, hash } = generateBlob();

    const response = await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.sha256).toBe(hash);
    expect(data.size).toBe(content.length);
  });

  test('HEAD checks if blob exists', async ({ server }) => {
    const { content, hash } = generateBlob();

    // Upload first
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // HEAD request
    const response = await fetch(`${server.baseUrl}/${hash}`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(content.length));
  });

  test('GET returns 404 for non-existent blob', async ({ server }) => {
    const fakeHash = createHash('sha256').update('does-not-exist').digest('hex');
    const response = await fetch(`${server.baseUrl}/${fakeHash}`);
    expect(response.status).toBe(404);
  });

  test('HEAD returns 404 for non-existent blob', async ({ server }) => {
    const fakeHash = createHash('sha256').update('also-does-not-exist').digest('hex');
    const response = await fetch(`${server.baseUrl}/${fakeHash}`, { method: 'HEAD' });
    expect(response.status).toBe(404);
  });
});
