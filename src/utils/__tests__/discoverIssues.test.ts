import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type Routes = Record<string, { status?: number; body?: unknown }>;

/** Calls one tool against a mock Seerr that answers from `routes` and records every call with its body. */
async function callVia(tool: string, args: Record<string, unknown>, routes: Routes) {
  const calls: Array<{ call: string; body?: unknown }> = [];
  const api = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const call = `${req.method} ${req.url}`;
      calls.push(raw ? { call, body: JSON.parse(raw) } : { call });
      const route = routes[call];
      if (route) {
        res.statusCode = route.status ?? 200;
        res.end(route.body === undefined ? '' : JSON.stringify(route.body));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: `Unexpected API call: ${call}` }));
      }
    });
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
    const response = await client.callTool({ name: tool, arguments: args });
    const content = response.content as Array<{ type: string; text: string }>;
    let result: any;
    try { result = JSON.parse(content[0].text); } catch { result = content[0].text; }
    return { result, isError: response.isError === true, calls };
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  }
}

const page = (results: unknown[]) => ({ page: 1, totalPages: 3, totalResults: 60, results });
const dune = { id: 438631, mediaType: 'movie', title: 'Dune', releaseDate: '2021-09-15', voteAverage: 7.8, overview: '' };
const severance = {
  id: 95396, mediaType: 'tv', name: 'Severance', firstAirDate: '2022-02-17', voteAverage: 8.4, overview: '',
  mediaInfo: { id: 12, tmdbId: 95396, status: 5 },
};
const person = { id: 1, mediaType: 'person', name: 'Someone' };

test('discover trending: passes mediaType and timeWindow, drops people, shows library status', async () => {
  const { result, calls } = await callVia('discover_media', { list: 'trending', timeWindow: 'week' }, {
    'GET /api/v1/discover/trending?page=1&language=en&mediaType=all&timeWindow=week': { body: page([dune, person, severance]) },
  });
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(result.list, 'trending');
  assert.deepEqual(result.results.map((r: any) => [r.id, r.type, r.status]), [
    [438631, 'movie', 'NOT_REQUESTED'],
    [95396, 'tv', 'AVAILABLE'],
  ]);
  assert.equal(result.totalPages, 3);
});

test('discover upcoming with mediaType all merges movies and tv', async () => {
  const { result, calls } = await callVia('discover_media', { list: 'upcoming' }, {
    'GET /api/v1/discover/movies/upcoming?page=1&language=en': { body: page([dune]) },
    'GET /api/v1/discover/tv/upcoming?page=1&language=en': { body: page([severance]) },
  });
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.deepEqual(result.results.map((r: any) => [r.id, r.type]), [[438631, 'movie'], [95396, 'tv']]);
});

test('discover popular tv uses /discover/tv and honours limit', async () => {
  const { result } = await callVia('discover_media', { list: 'popular', mediaType: 'tv', limit: 1 }, {
    'GET /api/v1/discover/tv?page=1&language=en': { body: page([severance, { ...severance, id: 1399, name: 'GoT' }]) },
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Severance');
});

const issue = {
  id: 7, issueType: 3, status: 1, problemSeason: 2, problemEpisode: 4,
  createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T11:00:00.000Z',
  media: { id: 12, tmdbId: 95396, mediaType: 'tv', status: 5 },
  createdBy: { id: 2, displayName: 'Lera', email: 'l@x' },
  comments: [
    { id: 1, message: 'Subs out of sync', user: { id: 2, displayName: 'Lera' }, createdAt: '2026-10-19T10:00:00.000Z' },
    { id: 2, message: 'Looking', user: { id: 1, displayName: 'Tom' }, createdAt: '2026-10-19T11:00:00.000Z' },
  ],
};
const tvDetails = { id: 95396, name: 'Severance', mediaInfo: { id: 12, tmdbId: 95396, status: 5 } };

test('issues list: open by default, compact with title from media details', async () => {
  const { result, calls } = await callVia('manage_issues', { action: 'list' }, {
    'GET /api/v1/issue?take=20&skip=0&sort=added&filter=open': {
      body: { pageInfo: { pages: 1, pageSize: 20, results: 1, page: 1 }, results: [issue] },
    },
    'GET /api/v1/tv/95396': { body: tvDetails },
  });
  assert.equal(calls[0].call, 'GET /api/v1/issue?take=20&skip=0&sort=added&filter=open');
  assert.deepEqual(result.results[0], {
    id: 7, type: 'SUBTITLES', status: 'OPEN', title: 'Severance', mediaType: 'tv', tmdbId: 95396,
    season: 2, episode: 4, createdBy: 'Lera', createdAt: issue.createdAt, updatedAt: issue.updatedAt,
    comments: 2, lastComment: 'Tom: Looking',
  });
});

test('issues get returns every comment', async () => {
  const { result } = await callVia('manage_issues', { action: 'get', issueId: 7 }, {
    'GET /api/v1/issue/7': { body: issue },
    'GET /api/v1/tv/95396': { body: tvDetails },
  });
  assert.deepEqual(result.comments, [
    { user: 'Lera', message: 'Subs out of sync', createdAt: issue.comments[0].createdAt },
    { user: 'Tom', message: 'Looking', createdAt: issue.comments[1].createdAt },
  ]);
});

test('issues create resolves the TMDB id to the Seerr media id', async () => {
  const { result, calls } = await callVia('manage_issues', {
    action: 'create', mediaType: 'tv', tmdbId: 95396, issueType: 'subtitles', message: 'Subs out of sync', season: 2, episode: 4,
  }, {
    'GET /api/v1/tv/95396': { body: tvDetails },
    'POST /api/v1/issue': { status: 201, body: issue },
  });
  const post = calls.find(c => c.call === 'POST /api/v1/issue');
  assert.deepEqual(post?.body, { mediaId: 12, issueType: 3, message: 'Subs out of sync', problemSeason: 2, problemEpisode: 4 });
  assert.equal(result.id, 7);
});

test('issues create refuses media Seerr does not track', async () => {
  const { result, isError, calls } = await callVia('manage_issues', {
    action: 'create', mediaType: 'movie', tmdbId: 438631, issueType: 'video', message: 'x',
  }, {
    'GET /api/v1/movie/438631': { body: { id: 438631, title: 'Dune' } },
  });
  assert.ok(isError, JSON.stringify(result));
  assert.match(String(result), /not in Seerr/);
  assert.ok(!calls.some(c => c.call.startsWith('POST')), JSON.stringify(calls));
});

test('issues comment, resolve and reopen hit the matching endpoints', async () => {
  const routes = {
    'POST /api/v1/issue/7/comment': { body: issue },
    'POST /api/v1/issue/7/resolved': { body: { ...issue, status: 2 } },
    'POST /api/v1/issue/7/open': { body: issue },
    'GET /api/v1/tv/95396': { body: tvDetails },
  };
  const commented = await callVia('manage_issues', { action: 'comment', issueId: 7, message: 'Fixed' }, routes);
  assert.deepEqual(commented.calls[0], { call: 'POST /api/v1/issue/7/comment', body: { message: 'Fixed' } });
  const resolved = await callVia('manage_issues', { action: 'resolve', issueId: 7 }, routes);
  assert.equal(resolved.result.status, 'RESOLVED');
  const reopened = await callVia('manage_issues', { action: 'reopen', issueId: 7 }, routes);
  assert.equal(reopened.calls[0].call, 'POST /api/v1/issue/7/open');
});
