import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Generate unique blob content for each test to avoid collisions
function generateBlob(): { content: Buffer; hash: string } {
  const content = Buffer.from(`test-blob-${randomBytes(16).toString('hex')}`);
  const hash = createHash('sha256').update(content).digest('hex');
  return { content, hash };
}

describe('Blob operations', () => {
  it('PUT uploads a blob and returns its hash', async () => {
    const { content, hash } = generateBlob();

    const response = await fetch(`${BASE_URL}/upload`, {
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

  it('GET fetches an uploaded blob', async () => {
    const { content, hash } = generateBlob();

    // Upload first
    await fetch(`${BASE_URL}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Fetch it back
    const response = await fetch(`${BASE_URL}/${hash}`);
    expect(response.status).toBe(200);

    const fetched = Buffer.from(await response.arrayBuffer());
    expect(fetched.equals(content)).toBe(true);
  });

  it('HEAD checks if blob exists', async () => {
    const { content, hash } = generateBlob();

    // Upload first
    await fetch(`${BASE_URL}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // HEAD request
    const response = await fetch(`${BASE_URL}/${hash}`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(content.length));
  });

  it('GET returns 404 for non-existent blob', async () => {
    const fakeHash = createHash('sha256').update('does-not-exist').digest('hex');
    const response = await fetch(`${BASE_URL}/${fakeHash}`);
    expect(response.status).toBe(404);
  });

  it('HEAD returns 404 for non-existent blob', async () => {
    const fakeHash = createHash('sha256').update('also-does-not-exist').digest('hex');
    const response = await fetch(`${BASE_URL}/${fakeHash}`, { method: 'HEAD' });
    expect(response.status).toBe(404);
  });
});
