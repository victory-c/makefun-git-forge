// git.ts: the object model and the wire formats a git forge needs, on node:crypto and node:zlib alone.
//
//   - a content-addressed object store (blob, tree, commit, tag) keyed by SHA-1 hex
//   - commit, tree and tag parsing / building
//   - pkt-line framing (encode, decode, side-band)
//   - packfile reading (plain, ofs-delta and ref-delta entries) and writing (plain entries)
//   - reachability walks: ancestry, object closures, shallow boundaries
//
// Nothing here knows about HTTP or repositories; smart.ts builds the protocol on top of it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

// ------------------------------------------------------------------------------------- the store

/** Every object the forge holds, shared by all repositories (content addressing makes that safe). */
export class ObjectStore {
  readonly objects = new Map<string, GitObj>();
  /** Deflated bodies, cached so a pack for 50 concurrent clones is compressed once. */
  private readonly deflated = new Map<string, Buffer>();
  private readonly commitCache = new Map<string, CommitInfo>();
  private readonly treeCache = new Map<string, TreeEntry[]>();

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): GitObj | undefined {
    return this.objects.get(sha);
  }

  put(type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  /** Store an object already hashed by the caller (pack ingestion computes the id once). */
  putWithSha(sha: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
  }

  deflatedOf(sha: string): Buffer {
    let body = this.deflated.get(sha);
    if (body === undefined) {
      const obj = this.objects.get(sha);
      if (obj === undefined) throw new Error(`missing object ${sha}`);
      body = deflateSync(obj.data, { level: 1 });
      this.deflated.set(sha, body);
    }
    return body;
  }

  commit(sha: string): CommitInfo | null {
    const cached = this.commitCache.get(sha);
    if (cached !== undefined) return cached;
    const obj = this.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') return null;
    const info = parseCommit(obj.data);
    this.commitCache.set(sha, info);
    return info;
  }

  tree(sha: string): TreeEntry[] | null {
    const cached = this.treeCache.get(sha);
    if (cached !== undefined) return cached;
    const obj = this.objects.get(sha);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    this.treeCache.set(sha, entries);
    return entries;
  }

  /** Follow annotated tags down to the object they finally name. */
  peel(sha: string): string {
    let current = sha;
    for (let guard = 0; guard < 16; guard += 1) {
      const obj = this.objects.get(current);
      if (obj === undefined || obj.type !== 'tag') return current;
      current = parseTag(obj.data).object;
    }
    return current;
  }
}

// ------------------------------------------------------------------------------------- objects

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface Signature {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree');
    const mode = data.toString('latin1', at, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree order: byte order, with a directory compared as if its name ended in '/'. */
function treeKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeKey(a));
    const kb = Buffer.from(treeKey(b));
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseSignature(text: string): Signature {
  const match = /^(.*?) <([^>]*)> (-?\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', time: 0, tz: '+0000' };
  return { name: match[1], email: match[2], time: Number(match[3]), tz: match[4] };
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = {
    tree: '',
    parents: [],
    author: { name: '', email: '', time: 0, tz: '+0000' },
    committer: { name: '', email: '', time: 0, tz: '+0000' },
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5);
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
    else if (line.startsWith('author ')) info.author = parseSignature(line.slice(7));
    else if (line.startsWith('committer ')) info.committer = parseSignature(line.slice(10));
  }
  return info;
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const out = { object: '', type: '', tag: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7);
    else if (line.startsWith('type ')) out.type = line.slice(5);
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
  }
  return out;
}

export function formatSignature(sig: Signature): string {
  return `${sig.name} <${sig.email}> ${sig.time} ${sig.tz}`;
}

export function buildCommit(fields: { tree: string; parents: readonly string[]; author: Signature; committer: Signature; message: string }): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatSignature(fields.author)}`);
  lines.push(`committer ${formatSignature(fields.committer)}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

// ------------------------------------------------------------------------------------- pkt-line

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/**
 * Decode pkt-lines from the start of `buffer`. Stops after `stopAfterFlush` flushes (0 = read to the end)
 * and answers where it stopped, so a receive-pack body's pack can be sliced off after the command list.
 */
export function readPackets(buffer: Buffer, stopAfterFlush = 0): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let offset = 0;
  let flushes = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line header ${JSON.stringify(hex)}`);
    const size = parseInt(hex, 16);
    if (size === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      flushes += 1;
      if (stopAfterFlush > 0 && flushes >= stopAfterFlush) break;
      continue;
    }
    if (size === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (size === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (size < 4 || offset + size > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return { packets, offset };
}

/** Wrap `data` in side-band packets on `band`, each within the 65520-byte pkt-line limit. */
export function sideband(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const max = 65515;
  for (let at = 0; at < data.length; at += max) {
    const chunk = data.subarray(at, Math.min(data.length, at + max));
    out.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ------------------------------------------------------------------------------------- packfiles

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = varint();
  const targetSize = varint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[at++];
      if (op & 0x02) copyOffset |= delta[at++] << 8;
      if (op & 0x04) copyOffset |= delta[at++] << 16;
      if (op & 0x08) copyOffset += delta[at++] * 0x1000000;
      if (op & 0x10) copySize |= delta[at++];
      if (op & 0x20) copySize |= delta[at++] << 8;
      if (op & 0x40) copySize |= delta[at++] << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta result size mismatch');
  return out;
}

/**
 * Read a packfile into the store. Plain entries are stored as they come; ofs-delta and ref-delta entries are
 * resolved against earlier entries of the same pack or objects the store already holds (a thin pack).
 * Answers the ids it stored. Throws on a corrupt pack; the caller reports "unpack <reason>".
 */
export function ingestPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack checksum mismatch');
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  const pendingRef: { offset: number; base: string; delta: Buffer }[] = [];
  const stored: string[] = [];
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const start = at;
    let byte = pack[at++];
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (code === 6) {
      byte = pack[at++];
      let rel = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[at++];
        rel = (rel + 1) * 128 + (byte & 0x7f);
      }
      const inflated = inflateAt(pack, at);
      at = inflated.next;
      const base = byOffset.get(start - rel);
      if (base === undefined) throw new Error('ofs-delta base not found');
      const data = applyDelta(base.data, inflated.data);
      byOffset.set(start, { type: base.type, data });
      const sha = hashObject(base.type, data);
      store.putWithSha(sha, base.type, data);
      stored.push(sha);
    } else if (code === 7) {
      const baseSha = pack.toString('hex', at, at + 20);
      at += 20;
      const inflated = inflateAt(pack, at);
      at = inflated.next;
      const base = store.get(baseSha);
      if (base === undefined) {
        pendingRef.push({ offset: start, base: baseSha, delta: inflated.data });
        continue;
      }
      const data = applyDelta(base.data, inflated.data);
      byOffset.set(start, { type: base.type, data });
      const sha = hashObject(base.type, data);
      store.putWithSha(sha, base.type, data);
      stored.push(sha);
    } else {
      const type = CODE_TYPE[code];
      if (type === undefined) throw new Error(`bad pack entry type ${code}`);
      const inflated = inflateAt(pack, at);
      at = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
      byOffset.set(start, { type, data: inflated.data });
      const sha = hashObject(type, inflated.data);
      store.putWithSha(sha, type, inflated.data);
      stored.push(sha);
    }
  }
  // ref-deltas whose base came later in the same pack
  for (let pass = 0; pendingRef.length > 0 && pass < 64; pass += 1) {
    for (let i = pendingRef.length - 1; i >= 0; i -= 1) {
      const entry = pendingRef[i];
      const base = store.get(entry.base);
      if (base === undefined) continue;
      const data = applyDelta(base.data, entry.delta);
      byOffset.set(entry.offset, { type: base.type, data });
      const sha = hashObject(base.type, data);
      store.putWithSha(sha, base.type, data);
      stored.push(sha);
      pendingRef.splice(i, 1);
    }
  }
  if (pendingRef.length > 0) throw new Error('ref-delta base not found');
  return stored;
}

/** A plain (undeltified) pack of `shas`, in the order given. */
export function writePack(store: ObjectStore, shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = store.get(sha);
    if (obj === undefined) throw new Error(`missing object ${sha}`);
    const bytes: number[] = [];
    let size = obj.data.length;
    let first = (TYPE_CODE[obj.type] << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size = Math.floor(size / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes), store.deflatedOf(sha));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ------------------------------------------------------------------------------------- walks

/** Whether `ancestor` is `descendant` or reachable from it through parents. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    const commit = store.commit(sha);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Every commit reachable from `tips` (tips included), not walking past `stopAt` commits' parents. */
export function ancestry(store: ObjectStore, tips: Iterable<string>, stopAt: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (store.commit(tip) !== null && !seen.has(tip)) {
      seen.add(tip);
      queue.push(tip);
    }
  }
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (stopAt.has(sha)) continue;
    const commit = store.commit(sha);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!seen.has(parent) && store.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return seen;
}

/** Add a tree and everything under it to `out`, skipping what `skip` already holds. */
export function addTreeClosure(store: ObjectStore, tree: string, out: Set<string>, skip: ReadonlySet<string>, order?: string[]): void {
  if (out.has(tree) || skip.has(tree)) return;
  out.add(tree);
  order?.push(tree);
  const entries = store.tree(tree);
  if (entries === null) return;
  for (const entry of entries) {
    if (entry.mode === '160000') continue; // a submodule names a commit of another repository
    if (entry.mode === '40000' || entry.mode === '040000') addTreeClosure(store, entry.sha, out, skip, order);
    else if (!out.has(entry.sha) && !skip.has(entry.sha)) {
      out.add(entry.sha);
      order?.push(entry.sha);
    }
  }
}

/** The best common ancestor of two commits (the first found walking `b`'s history breadth-first). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const fromA = ancestry(store, [a]);
  const queue = [b];
  const seen = new Set<string>([b]);
  for (let index = 0; index < queue.length; index += 1) {
    const sha = queue[index];
    if (fromA.has(sha)) return sha;
    const commit = store.commit(sha);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------- flat trees

export interface FlatEntry {
  mode: string;
  sha: string;
}

/** A tree as path -> {mode, sha} for every non-tree entry under it. */
export function flattenTree(store: ObjectStore, tree: string | null, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  if (tree === null) return out;
  const entries = store.tree(tree);
  if (entries === null) return out;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(store, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return out;
}

/** Build (and store) the tree for a flat path map; answers the root tree id. */
export function buildFlatTree(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Dir {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = dir.dirs.get(parts[i]);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i], child);
      }
      dir = child;
    }
    dir.files.set(parts[parts.length - 1], entry);
  }
  const write = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, sha: write(child) });
    return store.put('tree', buildTree(entries));
  };
  return write(root);
}
