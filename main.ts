// main.ts: the forge process. It binds an ephemeral port, registers it with the env, serves every surface
// (git smart HTTP, REST v3, GraphQL v4, MCP) from one in-memory store, and exits 0 once the env says done.
//
//   /healthz                         200 {"ok":true}, no token needed
//   /{owner}/{repo}.git/...          git smart HTTP (smart.ts)
//   /api/v3/...                      REST v3 (rest.ts)
//   /api/graphql                     GraphQL v4 (graphql.ts)
//   /mcp                             Model Context Protocol, streamable HTTP (mcp.ts)
//
// Every API call must carry the trial's token (MAKEFUN_SHOP_TOKEN) as a bearer token; a request without it
// is 401. Every REST answer is JSON and carries an X-GitHub-Request-Id. The transport is http.ts, a lean
// HTTP/1.1 server: every handler here is synchronous, so a request is parsed, answered and written in one go.

import { gunzipSync } from 'node:zlib';
import { ApiError, mutations } from './forge.ts';
import { createRawServer, type RawRequest, type RawResponse } from './http.ts';
import { route } from './rest.ts';
import { infoRefs, receivePack, uploadPack } from './smart.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const JSON_TYPE = 'application/json; charset=utf-8';
const BEARER = `Bearer ${TOKEN}`;

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `F0RGE:${requestCounter.toString(16).toUpperCase()}`;
}

/** Whether the request carries the trial's token (bearer, token or basic with the token as password). */
function authorized(header: string | undefined): boolean {
  if (TOKEN === '') return true;
  if (header === undefined) return false;
  if (header === BEARER) return true;
  const match = /^(\S+)\s+(.+)$/.exec(header.trim());
  if (match === null) return false;
  const scheme = match[1].toLowerCase();
  if (scheme === 'bearer' || scheme === 'token') return match[2] === TOKEN;
  if (scheme === 'basic') {
    const decoded = Buffer.from(match[2], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return decoded.slice(colon + 1) === TOKEN || decoded.slice(0, colon) === TOKEN;
  }
  return false;
}

const REST_HEADERS = { 'x-oauth-scopes': 'repo, read:org, workflow', 'x-accepted-oauth-scopes': 'repo' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): RawResponse {
  const out: Record<string, string> = { 'content-type': JSON_TYPE, 'x-github-request-id': requestId(), ...headers };
  if (status === 204 || body === null || body === undefined) return { status, headers: out, body: null };
  return { status, headers: out, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

// Cache only successful, authenticated, bodyless REST reads. Every state-changing
// request invalidates the entire cache, including writes through git, GraphQL and MCP.
// Host and the complete URL are part of the key: origins, queries and pages never mix.
const readResponses = new Map<string, RawResponse>();
let readBytes = 0;
function dispatch(req: RawRequest): RawResponse {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    mutations.epoch += 1;
    readResponses.clear();
    readBytes = 0;
  }
  const cacheable = req.method === 'GET' && req.body.length === 0 &&
    req.url.startsWith('/api/v3/') && authorized(req.headers.authorization);
  if (!cacheable) return serveRequest(req);
  const key = `${req.headers.host ?? '127.0.0.1'}\n${req.url}`;
  const previous = readResponses.get(key);
  if (previous !== undefined) return previous;
  const response = serveRequest(req);
  const bytes = response.body === null ? 0 : Buffer.byteLength(response.body);
  if (response.status === 200 && bytes <= 65536) {
    if (readBytes + bytes > 4 * 1024 * 1024 || readResponses.size >= 512) {
      readResponses.clear();
      readBytes = 0;
    }
    response.reusable = true;
    readResponses.set(key, response);
    readBytes += bytes;
  }
  return response;
}

function serveRequest(req: RawRequest): RawResponse {
  const { method, url, headers } = req;
  const q = url.indexOf('?');
  let path = q < 0 ? url : url.slice(0, q);
  const rawQuery = q < 0 ? '' : url.slice(q + 1);
  if (path.includes('%')) {
    try {
      path = decodeURI(path);
    } catch {
      // keep the raw path
    }
  }
  const host = headers.host ?? '127.0.0.1';
  const base = `http://${host}`;

  if (path === '/healthz' || path === '/healthz/') return json(200, '{"ok":true}');

  // ------------------------------------------------------------------ REST v3 (the hot path, first)
  if (path.startsWith('/api/v3/') || path === '/api/v3') {
    if (!authorized(headers.authorization)) {
      return json(401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' }, { 'www-authenticate': 'Bearer' });
    }
    let parsed: unknown = undefined;
    if (req.body.length > 0) {
      try {
        parsed = JSON.parse(req.body.toString('utf8'));
      } catch {
        return json(400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest' });
      }
    }
    let sub = path.slice(7);
    if (sub.endsWith('/')) sub = sub.replace(/\/+$/, '');
    try {
      const answer = route({ method, path: sub, query: new URLSearchParams(rawQuery), body: parsed, base });
      return json(answer.status, answer.raw ?? answer.body, answer.headers === undefined ? REST_HEADERS : { ...REST_HEADERS, ...answer.headers });
    } catch (err) {
      if (err instanceof ApiError) return json(err.status, { message: err.message, ...err.extra, documentation_url: 'https://docs.github.com/rest' });
      process.stderr.write(`[forge] ${method} ${path}: ${err instanceof Error ? err.stack : String(err)}\n`);
      return json(500, { message: 'Server Error' });
    }
  }

  // ------------------------------------------------------------------ git smart HTTP
  const git = GIT_PATH.exec(path);
  if (git !== null) {
    if (!authorized(headers.authorization)) {
      return { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="forge"' }, body: 'Authentication required\n' };
    }
    const [, owner, name, action] = git;
    const protocol = headers['git-protocol'] ?? '';
    let body = req.body;
    if ((headers['content-encoding'] ?? '').toLowerCase() === 'gzip') {
      try {
        body = gunzipSync(body);
      } catch {
        return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'bad gzip body\n' };
      }
    }
    let answer;
    if (action === 'info/refs' && (method === 'GET' || method === 'HEAD')) answer = infoRefs(owner, name, new URLSearchParams(rawQuery).get('service'), protocol);
    else if (action === 'git-upload-pack' && method === 'POST') answer = uploadPack(owner, name, body, protocol);
    else if (action === 'git-receive-pack' && method === 'POST') answer = receivePack(owner, name, body);
    else return { status: 405, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Method Not Allowed\n' };
    return answer;
  }

  // ------------------------------------------------------------------ MCP
  if (path === '/mcp' || path === '/mcp/') {
    if (!authorized(headers.authorization)) {
      return json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: a bearer token is required' } }, { 'www-authenticate': 'Bearer' });
    }
    const answer = handleMcp(method, req.body, base);
    if (answer.body === null) return { status: answer.status, headers: answer.headers, body: null };
    return { status: answer.status, headers: { 'content-type': JSON_TYPE, ...answer.headers }, body: JSON.stringify(answer.body) };
  }

  // ------------------------------------------------------------------ GraphQL
  if (path === '/api/graphql' || path === '/api/graphql/' || path === '/graphql') {
    if (!authorized(headers.authorization)) return json(401, { message: 'This endpoint requires you to be authenticated.', documentation_url: 'https://docs.github.com/graphql' });
    if (method !== 'POST') return json(405, { message: 'Method Not Allowed' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString('utf8'));
    } catch {
      return json(400, { message: 'Problems parsing JSON' });
    }
    return json(200, handleGraphQL(parsed, base));
  }

  return json(404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------- the lifecycle

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(10_000),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered')) throw err;
    }
    await sleep(Math.min(1000, 100 * 2 ** Math.min(attempt, 4)));
  }
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      } else await res.arrayBuffer().catch(() => undefined);
    } catch {
      // not done yet, or the env is busy: poll again
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const server = createRawServer(dispatch);
  const wanted = ENV_URL === '' ? Number(process.env.PORT ?? 0) : 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted === 8080 ? 0 : wanted, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port bound');
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  if (ENV_URL === '') {
    process.stdout.write('[forge] MAKEFUN_ENV_URL is not set: serving until stopped\n');
    return new Promise(() => undefined);
  }
  await register(address.port);
  process.stdout.write('[forge] registered; serving until the env says done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
