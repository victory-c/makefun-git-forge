// http.ts: a lean HTTP/1.1 server on node:net, for a forge whose every handler is synchronous.
//
// node:http builds an IncomingMessage and a ServerResponse, emits events and streams for every request; this
// server parses the request head itself, collects the body (Content-Length or chunked), calls the handler
// and writes the whole answer with one socket write. It keeps connections alive (HTTP/1.1 default), answers
// pipelined requests in order, honours Expect: 100-continue and closes on a malformed request.

import { createServer, type Server, type Socket } from 'node:net';

export interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface RawResponse {
  status: number;
  /** Lowercase header names; content-length is added here. */
  headers: Record<string, string>;
  body: Buffer | string | null;
  /** Immutable answer eligible for transport-frame reuse. */
  reusable?: boolean;
}

export type RawHandler = (req: RawRequest) => RawResponse;

const REASONS: Record<number, string> = {
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
};

const MAX_HEAD = 64 * 1024;
const MAX_BODY = 768 * 1024 * 1024;
const HEAD_END = Buffer.from('\r\n\r\n');

/** One answer as bytes: status line, headers, content-length, then the body (none for HEAD). */
const frames = new WeakMap<RawResponse, Buffer>();
function render(res: RawResponse, keepAlive: boolean, isHead: boolean): Buffer | string {
  if (!res.reusable || !keepAlive || isHead) return renderUncached(res, keepAlive, isHead);
  let frame = frames.get(res);
  if (frame === undefined) {
    const output = renderUncached(res, true, false);
    frame = typeof output === 'string' ? Buffer.from(output) : output;
    frames.set(res, frame);
  }
  return frame;
}

function renderUncached(res: RawResponse, keepAlive: boolean, isHead: boolean): Buffer | string {
  const body = res.body ?? '';
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  let head = `HTTP/1.1 ${res.status} ${REASONS[res.status] ?? 'Status'}\r\n`;
  for (const name in res.headers) head += `${name}: ${res.headers[name]}\r\n`;
  head += `content-length: ${length}\r\n`;
  head += keepAlive ? 'keep-alive: timeout=120\r\n\r\n' : 'connection: close\r\n\r\n';
  if (isHead || length === 0) return head;
  if (typeof body === 'string') return head + body;
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}

/** Decode a complete chunked body starting at `start`, or null while it is still arriving. */
function dechunk(buf: Buffer, start: number): { body: Buffer; end: number } | null {
  const parts: Buffer[] = [];
  let at = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', at, 'latin1');
    if (lineEnd < 0) return null;
    const size = parseInt(buf.toString('latin1', at, lineEnd).split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
    at = lineEnd + 2;
    if (size === 0) {
      // trailers end with an empty line
      for (;;) {
        const trailerEnd = buf.indexOf('\r\n', at, 'latin1');
        if (trailerEnd < 0) return null;
        const empty = trailerEnd === at;
        at = trailerEnd + 2;
        if (empty) return { body: parts.length === 1 ? parts[0] : Buffer.concat(parts), end: at };
      }
    }
    if (at + size + 2 > buf.length) return null;
    parts.push(buf.subarray(at, at + size));
    at += size + 2;
  }
}

function serve(socket: Socket, handler: RawHandler): void {
  socket.setNoDelay(true);
  socket.setTimeout(180_000, () => socket.destroy());
  let buffered: Buffer | null = null;
  let continued = false;
  let closed = false;

  const fail = (status: number): void => {
    if (closed) return;
    closed = true;
    socket.end(render({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ message: REASONS[status] ?? 'Bad Request' }) }, false, false));
  };

  const pump = (): void => {
    while (!closed && buffered !== null && buffered.length > 0) {
      const buf: Buffer = buffered;
      const headEnd = buf.indexOf(HEAD_END);
      if (headEnd > MAX_HEAD) {
        fail(431);
        return;
      }
      if (headEnd < 0) {
        if (buf.length > MAX_HEAD) fail(431);
        return;
      }
      const head = buf.toString('latin1', 0, headEnd);
      const lines = head.split('\r\n');
      const requestLine = lines[0];
      const firstSpace = requestLine.indexOf(' ');
      const lastSpace = requestLine.lastIndexOf(' ');
      if (firstSpace <= 0 || lastSpace <= firstSpace) {
        fail(400);
        return;
      }
      const method = requestLine.slice(0, firstSpace);
      const url = requestLine.slice(firstSpace + 1, lastSpace);
      const version = requestLine.slice(lastSpace + 1);
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i];
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        const prior = headers[name];
        headers[name] = prior === undefined ? value : `${prior}, ${value}`;
      }
      const bodyStart = headEnd + 4;
      let body: Buffer;
      let end: number;
      const te = headers['transfer-encoding'];
      if (te !== undefined && te.toLowerCase().includes('chunked')) {
        if (!continued && (headers.expect ?? '').toLowerCase() === '100-continue') {
          continued = true;
          socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        }
        let decoded: { body: Buffer; end: number } | null;
        try {
          decoded = dechunk(buf, bodyStart);
        } catch {
          fail(400);
          return;
        }
        if (decoded === null) {
          if (buf.length - bodyStart > MAX_BODY) fail(413);
          return;
        }
        body = decoded.body;
        end = decoded.end;
      } else {
        const declared = headers['content-length'];
        const length = declared === undefined ? 0 : Number(declared);
        if (!Number.isSafeInteger(length) || length < 0) {
          fail(400);
          return;
        }
        if (length > MAX_BODY) {
          fail(413);
          return;
        }
        if (buf.length < bodyStart + length) {
          if (!continued && length > 0 && (headers.expect ?? '').toLowerCase() === '100-continue') {
            continued = true;
            socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          }
          return;
        }
        body = buf.subarray(bodyStart, bodyStart + length);
        end = bodyStart + length;
      }
      buffered = end >= buf.length ? null : buf.subarray(end);
      continued = false;
      const connection = (headers.connection ?? '').toLowerCase();
      const keepAlive = version === 'HTTP/1.0' ? connection.includes('keep-alive') : !connection.includes('close');
      let res: RawResponse;
      try {
        res = handler({ method, url, headers, body });
      } catch (err) {
        process.stderr.write(`[forge] ${method} ${url}: ${err instanceof Error ? err.stack : String(err)}\n`);
        res = { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"message":"Server Error"}' };
      }
      const out = render(res, keepAlive, method === 'HEAD');
      if (keepAlive) socket.write(out);
      else {
        closed = true;
        socket.end(out);
      }
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffered = buffered === null || buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    pump();
  });
  socket.on('error', () => socket.destroy());
  socket.on('end', () => {
    if (!closed) socket.end();
  });
}

export function createRawServer(handler: RawHandler): Server {
  return createServer({ noDelay: true, keepAlive: true }, (socket) => serve(socket, handler));
}
