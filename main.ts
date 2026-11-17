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
// is 401. Every REST answer is JSON and carries an X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiError } from './forge.ts';
import { route } from './rest.ts';
import { infoRefs, receivePack, uploadPack } from './smart.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `F0RGE:${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Whether the request carries the trial's token (bearer, token or basic with the token as password). */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (TOKEN === '') return true;
  if (typeof header !== 'string') return false;
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

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const base: Record<string, string> = { 'x-github-request-id': requestId(), 'x-github-media-type': 'github.v3; format=json', ...headers };
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, { ...base, 'content-type': JSON_TYPE, 'content-length': '0' });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...base, 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const q = rawUrl.indexOf('?');
  let path = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : rawUrl.slice(q + 1));
  try {
    path = decodeURI(path);
  } catch {
    // keep the raw path
  }

  if (path === '/healthz' || path === '/healthz/') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = await readBody(req);

  // ------------------------------------------------------------------ git smart HTTP
  const git = GIT_PATH.exec(path);
  if (git !== null) {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="forge"' });
      res.end('Authentication required\n');
      return;
    }
    const [, owner, name, action] = git;
    const protocol = String(req.headers['git-protocol'] ?? '');
    let answer;
    if (action === 'info/refs' && (method === 'GET' || method === 'HEAD')) answer = infoRefs(owner, name, query.get('service'), protocol);
    else if (action === 'git-upload-pack' && method === 'POST') answer = uploadPack(owner, name, await inflateBody(req, body), protocol);
    else if (action === 'git-receive-pack' && method === 'POST') answer = receivePack(owner, name, await inflateBody(req, body));
    else answer = { status: 405, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Method Not Allowed\n') };
    res.writeHead(answer.status, { ...answer.headers, 'content-length': answer.body.length });
    res.end(method === 'HEAD' ? undefined : answer.body);
    return;
  }

  // ------------------------------------------------------------------ MCP
  if (path === '/mcp' || path === '/mcp/') {
    if (!authorized(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: a bearer token is required' } }, { 'www-authenticate': 'Bearer' });
      return;
    }
    const answer = await handleMcp(method, req.headers, body, originOf(req));
    if (answer.body === null) {
      res.writeHead(answer.status, { ...answer.headers, 'content-length': '0' });
      res.end();
      return;
    }
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    res.writeHead(answer.status, { 'content-type': JSON_TYPE, ...answer.headers, 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }

  // ------------------------------------------------------------------ GraphQL
  if (path === '/api/graphql' || path === '/api/graphql/' || path === '/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'This endpoint requires you to be authenticated.', documentation_url: 'https://docs.github.com/graphql' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    sendJson(res, 200, handleGraphQL(parsed, originOf(req)));
    return;
  }

  // ------------------------------------------------------------------ REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' }, { 'www-authenticate': 'Bearer' });
      return;
    }
    let parsed: unknown = undefined;
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest' });
        return;
      }
    }
    const sub = path.slice('/api/v3'.length).replace(/\/+$/, '');
    try {
      const answer = route({ method, path: sub, query, body: parsed, base: originOf(req) });
      sendJson(res, answer.status, answer.body, { 'x-oauth-scopes': 'repo, read:org, workflow', 'x-accepted-oauth-scopes': 'repo', ...(answer.headers ?? {}) });
    } catch (err) {
      if (err instanceof ApiError) sendJson(res, err.status, { message: err.message, ...err.extra, documentation_url: 'https://docs.github.com/rest' });
      else {
        process.stderr.write(`[forge] ${method} ${path}: ${err instanceof Error ? err.stack : String(err)}\n`);
        sendJson(res, 500, { message: 'Server Error' });
      }
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** A git client may gzip its request body. */
async function inflateBody(req: IncomingMessage, body: Buffer): Promise<Buffer> {
  if (String(req.headers['content-encoding'] ?? '').toLowerCase() !== 'gzip') return body;
  const { gunzipSync } = await import('node:zlib');
  return gunzipSync(body);
}

function createApp() {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      process.stderr.write(`[forge] unhandled: ${err instanceof Error ? err.stack : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Server Error' });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;
  return server;
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
  const server = createApp();
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
