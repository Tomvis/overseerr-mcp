import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Runs manage_media_requests against a mock Seerr that records every call. */
async function deleteVia(args: Record<string, unknown>, fileStatus = 204) {
  const calls: string[] = [];
  const api = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const call = `${req.method} ${req.url}`;
    calls.push(call);
    if (call === 'GET /api/v1/request/289') {
      res.end(JSON.stringify({ id: 289, status: 2, is4k: false, media: { id: 488, tmdbId: 1422, status: 3, mediaType: 'movie' } }));
    } else if (call === 'DELETE /api/v1/media/488/file?is4k=false') {
      res.statusCode = fileStatus;
      res.end(fileStatus === 204 ? '' : JSON.stringify({ message: 'No Radarr server configured to delete media files' }));
    } else if (['DELETE /api/v1/request/289', 'DELETE /api/v1/media/488'].includes(call)) {
      res.statusCode = 204;
      res.end();
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `Unexpected API call: ${call}` }));
    }
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../index.js', import.meta.url))],
    env: {
      SEERR_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      SEERR_API_KEY: 'regression-test-key-local-only',
      HTTP_MODE: 'false',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'regression-tests', version: '1.0.0' });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'manage_media_requests', arguments: { action: 'delete', ...args } });
    const content = response.content as Array<{ type: string; text: string }>;
    return { result: JSON.parse(content[0].text), calls };
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  }
}

test('delete: without removeMedia only the request row goes', async () => {
  const { result, calls } = await deleteVia({ requestIds: [289] });
  assert.equal(result.summary.deleted, 1, JSON.stringify(result));
  assert.deepEqual(calls, ['DELETE /api/v1/request/289']);
});

test('delete: removeMedia removes the files from the *arr, then the request and the media', async () => {
  const { result, calls } = await deleteVia({ requestIds: [289], removeMedia: true });
  assert.equal(result.summary.deleted, 1, JSON.stringify(result));
  assert.deepEqual(result.results, [{ id: 289, deleted: true, mediaId: 488, mediaRemoved: true }]);
  assert.deepEqual(calls, [
    'GET /api/v1/request/289',
    'DELETE /api/v1/media/488/file?is4k=false',
    'DELETE /api/v1/request/289',
    'DELETE /api/v1/media/488',
  ]);
});

test('delete: removeMedia keeps the request when the *arr removal fails', async () => {
  const { result, calls } = await deleteVia({ requestIds: [289], removeMedia: true }, 409);
  assert.equal(result.summary.failed, 1, JSON.stringify(result));
  assert.ok(!calls.includes('DELETE /api/v1/request/289'), calls.join('\n'));
  assert.ok(!calls.includes('DELETE /api/v1/media/488'), calls.join('\n'));
});
