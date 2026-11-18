// smart.ts: git smart HTTP. info/refs advertisements (upload-pack v0 and v2, receive-pack v0), the v2
// ls-refs and fetch commands, the v0 fetch exchange, and receive-pack with report-status over side-band-64k.
//
// The handlers answer {status, headers, body}; main.ts writes them. A fetch's answer for the same repository
// state and the same request bytes is cached, so a burst of identical clones builds one pack.

import { createHash } from 'node:crypto';
import {
  DELIM,
  FLUSH,
  ZERO,
  addTreeClosure,
  ancestry,
  ingestPack,
  isAncestor,
  pkt,
  readPackets,
  sideband,
  writePack,
  type Packet,
} from './git.ts';
import { findRepo, setRef, settleDefaultBranch, store, type Repo } from './forge.ts';

export interface GitAnswer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  reusable: boolean;
}

const AGENT = 'agent=git/2.47.0-forge';

function answer(status: number, contentType: string, body: Buffer): GitAnswer {
  return { status, headers: { 'content-type': contentType, 'cache-control': 'no-cache', expires: 'Fri, 01 Jan 1980 00:00:00 GMT', pragma: 'no-cache' }, body, reusable: true };
}

function notFound(): GitAnswer {
  return answer(404, 'text/plain; charset=utf-8', Buffer.from('Repository not found\n'));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The repository's refs in advertisement order (sorted by name). */
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ------------------------------------------------------------------------------------- info/refs

const refAnswers = new WeakMap<Repo, { version: number; branch: string; entries: Map<string, GitAnswer> }>();
function refAnswer(repo: Repo, key: string, build: () => GitAnswer): GitAnswer {
  let cache = refAnswers.get(repo);
  if (cache === undefined || cache.version !== repo.version || cache.branch !== repo.defaultBranch) {
    cache = { version: repo.version, branch: repo.defaultBranch, entries: new Map() };
    refAnswers.set(repo, cache);
  }
  const previous = cache.entries.get(key);
  if (previous !== undefined) return previous;
  const response = build();
  if (cache.entries.size >= 64) cache.entries.clear();
  cache.entries.set(key, response);
  return response;
}

export function infoRefs(owner: string, name: string, service: string | null, gitProtocol: string): GitAnswer {
  const repo = findRepo(owner, name);
  if (repo === null) return notFound();
  return refAnswer(repo, JSON.stringify([service, gitProtocol]), () => advertiseRefs(repo, service, gitProtocol));
}

function advertiseRefs(repo: Repo, service: string | null, gitProtocol: string): GitAnswer {
  if (service === 'git-upload-pack') {
    if (/version=2/.test(gitProtocol)) {
      const lines = [pkt('version 2\n'), pkt(`${AGENT}\n`), pkt('ls-refs=unborn\n'), pkt('fetch=shallow\n'), pkt('server-option\n'), pkt('object-format=sha1\n'), FLUSH];
      return answer(200, 'application/x-git-upload-pack-advertisement', Buffer.concat(lines));
    }
    const caps = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:${headTarget(repo)} object-format=sha1 ${AGENT}`;
    return answer(200, 'application/x-git-upload-pack-advertisement', Buffer.concat([pkt('# service=git-upload-pack\n'), FLUSH, ...v0RefLines(repo, caps, true), FLUSH]));
  }
  if (service === 'git-receive-pack') {
    const caps = `report-status delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 ${AGENT}`;
    return answer(200, 'application/x-git-receive-pack-advertisement', Buffer.concat([pkt('# service=git-receive-pack\n'), FLUSH, ...v0RefLines(repo, caps, false), FLUSH]));
  }
  // the dumb protocol is not served
  return answer(403, 'text/plain; charset=utf-8', Buffer.from('Please upgrade your git client.\n'));
}

function v0RefLines(repo: Repo, caps: string, withHead: boolean): Buffer[] {
  const lines: string[] = [];
  const head = repo.refs.get(headTarget(repo));
  if (withHead && head !== undefined) lines.push(`${head} HEAD`);
  for (const [ref, sha] of sortedRefs(repo)) {
    lines.push(`${sha} ${ref}`);
    if (withHead && ref.startsWith('refs/tags/')) {
      const peeled = store.peel(sha);
      if (peeled !== sha) lines.push(`${peeled} ${ref}^{}`);
    }
  }
  if (lines.length === 0) lines.push(`${ZERO} capabilities^{}`);
  return lines.map((line, index) => pkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
}

// ------------------------------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

const fetchCache = new Map<string, GitAnswer>();

export function uploadPack(owner: string, name: string, body: Buffer, gitProtocol: string): GitAnswer {
  const repo = findRepo(owner, name);
  if (repo === null) return notFound();
  let packets: Packet[];
  try {
    packets = readPackets(body).packets;
  } catch (err) {
    return answer(400, 'text/plain; charset=utf-8', Buffer.from(`malformed request: ${(err as Error).message}\n`));
  }
  const first = packets.find((p) => p.kind === 'data');
  const isV2 = /version=2/.test(gitProtocol) || (first !== undefined && first.kind === 'data' && first.payload.toString('utf8').startsWith('command='));
  try {
    if (isV2) return v2Command(repo, packets, body);
    return v0Fetch(repo, packets);
  } catch (err) {
    const message = (err as Error).message;
    return answer(200, 'application/x-git-upload-pack-result', Buffer.concat([pkt(`ERR ${message}\n`), FLUSH]));
  }
}

function lineOf(packet: Packet): string | null {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : null;
}

function v2Command(repo: Repo, packets: Packet[], body: Buffer): GitAnswer {
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    const line = lineOf(packet);
    if (line === null) continue;
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else args.push(line);
  }
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') {
    const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
    for (const arg of args) {
      if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) parsed.depth = Number(arg.slice(7));
      else if (arg.startsWith('want-ref ')) {
        const sha = repo.refs.get(arg.slice(9).trim());
        if (sha !== undefined) parsed.wants.push(sha);
      } else if (arg === 'done') parsed.done = true;
    }
    const cacheKey = `${repo.id}:${repo.version}:${createHash('sha1').update(body).digest('hex')}`;
    const cached = fetchCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = answer(200, 'application/x-git-upload-pack-result', v2Fetch(parsed));
    if (fetchCache.size > 256) fetchCache.clear();
    fetchCache.set(cacheKey, result);
    return result;
  }
  if (command === '') return answer(400, 'text/plain; charset=utf-8', Buffer.from('no command\n'));
  return answer(200, 'application/x-git-upload-pack-result', Buffer.concat([pkt(`ERR unknown command ${command}\n`), FLUSH]));
}

function lsRefs(repo: Repo, args: string[]): GitAnswer {
  return refAnswer(repo, JSON.stringify(['ls-refs', args]), () => buildLsRefs(repo, args));
}

function buildLsRefs(repo: Repo, args: string[]): GitAnswer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice(11));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const target = headTarget(repo);
  const head = repo.refs.get(target);
  if (keep('HEAD')) {
    if (head !== undefined) lines.push(pkt(`${head} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    else if (unborn) lines.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    let line = `${sha} ${ref}`;
    if (peel) {
      const peeled = store.peel(sha);
      if (peeled !== sha) line += ` peeled:${peeled}`;
    }
    lines.push(pkt(`${line}\n`));
  }
  lines.push(FLUSH);
  return answer(200, 'application/x-git-upload-pack-result', Buffer.concat(lines));
}

interface PackPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/** Decide which objects a fetch sends and how its shallow boundary moves. */
function planFetch(args: FetchArgs): PackPlan {
  const clientShallow = new Set(args.shallow.filter((sha) => store.has(sha)));
  const common = args.haves.filter((sha) => store.has(sha));
  // What the client holds: its haves' history, never past its own shallow boundary, with every tree and blob.
  const haveCommits = ancestry(store, common.map((sha) => store.peel(sha)), clientShallow);
  const held = new Set<string>();
  for (const sha of common) held.add(sha);
  for (const sha of haveCommits) {
    held.add(sha);
    const info = store.commit(sha);
    if (info !== null) addTreeClosure(store, info.tree, held, new Set());
  }
  // The wants: tag objects are sent and followed to the commits they name.
  const order: string[] = [];
  const sent = new Set<string>();
  const tips: string[] = [];
  for (const want of args.wants) {
    if (!store.has(want)) throw new Error(`not our ref ${want}`);
    let current = want;
    for (let guard = 0; guard < 16; guard += 1) {
      const obj = store.get(current);
      if (obj === undefined || obj.type !== 'tag') break;
      if (!held.has(current) && !sent.has(current)) {
        sent.add(current);
        order.push(current);
      }
      current = store.peel(current) === current ? current : (obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m)?.[1] ?? current);
    }
    tips.push(current);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const commits: string[] = [];
  if (args.depth !== null && args.depth > 0) {
    const depthOf = new Map<string, number>();
    const queue: string[] = [];
    for (const tip of tips) {
      if (store.commit(tip) !== null && !depthOf.has(tip)) {
        depthOf.set(tip, 1);
        queue.push(tip);
      }
    }
    for (let index = 0; index < queue.length; index += 1) {
      const sha = queue[index];
      const depth = depthOf.get(sha) as number;
      const info = store.commit(sha);
      if (info === null) continue;
      commits.push(sha);
      if (depth >= args.depth) {
        if (info.parents.length > 0 && !clientShallow.has(sha)) shallow.push(sha);
        continue;
      }
      if (clientShallow.has(sha) && info.parents.length > 0) unshallow.push(sha);
      for (const parent of info.parents) {
        if (!store.has(parent)) continue;
        const known = depthOf.get(parent);
        if (known === undefined || known > depth + 1) {
          depthOf.set(parent, depth + 1);
          queue.push(parent);
        }
      }
    }
  } else {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha) || held.has(sha)) continue;
      seen.add(sha);
      const info = store.commit(sha);
      if (info === null) {
        commits.push(sha);
        continue;
      }
      commits.push(sha);
      for (const parent of info.parents) if (store.has(parent)) stack.push(parent);
    }
  }
  for (const sha of commits) {
    if (held.has(sha) || sent.has(sha)) continue;
    sent.add(sha);
    order.push(sha);
    const info = store.commit(sha);
    if (info !== null) addTreeClosure(store, info.tree, sent, held, order);
  }
  return { objects: order, shallow, unshallow, common };
}

function packSection(objects: string[]): Buffer[] {
  return sideband(1, writePack(store, objects));
}

function v2Fetch(args: FetchArgs): Buffer {
  const plan = planFetch(args);
  const out: Buffer[] = [];
  if (!args.done && args.haves.length > 0) {
    out.push(pkt('acknowledgments\n'));
    if (plan.common.length === 0) out.push(pkt('NAK\n'));
    for (const sha of plan.common) out.push(pkt(`ACK ${sha}\n`));
    out.push(pkt('ready\n'), DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0 || args.depth !== null) {
    out.push(pkt('shallow-info\n'));
    for (const sha of plan.shallow) out.push(pkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) out.push(pkt(`unshallow ${sha}\n`));
    out.push(DELIM);
  }
  out.push(pkt('packfile\n'), ...packSection(plan.objects), FLUSH);
  return Buffer.concat(out);
}

function v0Fetch(repo: Repo, packets: Packet[]): GitAnswer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let sidebandOn = false;
  for (const packet of packets) {
    const line = lineOf(packet);
    if (line === null) continue;
    if (line.startsWith('want ')) {
      const parts = line.slice(5).split(' ');
      args.wants.push(parts[0]);
      if (parts.includes('side-band-64k') || parts.includes('side-band')) sidebandOn = true;
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7));
    else if (line === 'done') args.done = true;
  }
  if (args.wants.length === 0) return answer(200, 'application/x-git-upload-pack-result', FLUSH);
  void repo;
  const plan = planFetch(args);
  const out: Buffer[] = [];
  if (args.depth !== null || args.shallow.length > 0) {
    for (const sha of plan.shallow) out.push(pkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) out.push(pkt(`unshallow ${sha}\n`));
    out.push(FLUSH);
  }
  if (!args.done) {
    for (const sha of plan.common) out.push(pkt(`ACK ${sha} common\n`));
    out.push(pkt('NAK\n'));
    return answer(200, 'application/x-git-upload-pack-result', Buffer.concat(out));
  }
  out.push(pkt(plan.common.length > 0 ? `ACK ${plan.common[plan.common.length - 1]}\n` : 'NAK\n'));
  const pack = writePack(store, plan.objects);
  if (sidebandOn) out.push(...sideband(1, pack), FLUSH);
  else out.push(pack);
  return answer(200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// ------------------------------------------------------------------------------------- receive-pack

interface Command {
  old: string;
  next: string;
  ref: string;
}

export function receivePack(owner: string, name: string, body: Buffer): GitAnswer {
  const repo = findRepo(owner, name);
  if (repo === null) return notFound();
  let commands: Command[] = [];
  let caps: string[] = [];
  let packStart = 0;
  try {
    const read = readPackets(body, 1);
    packStart = read.offset;
    for (const packet of read.packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1).trim().split(' ');
        line = line.slice(0, nul);
      }
      const [old, next, ref] = line.trim().split(' ');
      if (old === undefined || next === undefined || ref === undefined) throw new Error('bad command line');
      commands.push({ old, next, ref });
    }
  } catch (err) {
    return answer(400, 'text/plain; charset=utf-8', Buffer.from(`malformed request: ${(err as Error).message}\n`));
  }
  const useSideband = caps.includes('side-band-64k') || caps.includes('side-band');
  const reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
  const atomic = caps.includes('atomic');
  let unpackError: string | null = null;
  const pack = body.subarray(packStart);
  if (pack.length > 0) {
    try {
      ingestPack(store, pack);
    } catch (err) {
      unpackError = (err as Error).message || 'unpack failed';
    }
  }
  const results: { ref: string; error: string | null }[] = [];
  const accepted: Command[] = [];
  for (const command of commands) {
    results.push({ ref: command.ref, error: unpackError !== null ? 'unpacker error' : validate(repo, command) });
  }
  if (atomic && results.some((result) => result.error !== null)) {
    for (const result of results) if (result.error === null) result.error = 'atomic push failure';
  }
  const created: string[] = [];
  for (let i = 0; i < commands.length; i += 1) {
    if (results[i].error !== null) continue;
    const command = commands[i];
    if (command.next === ZERO) setRef(repo, command.ref, null);
    else {
      if (!repo.refs.has(command.ref)) created.push(command.ref);
      setRef(repo, command.ref, command.next);
    }
    accepted.push(command);
  }
  if (created.length > 0) settleDefaultBranch(repo, created);
  commands = [];
  if (!reportStatus) return answer(200, 'application/x-git-receive-pack-result', useSideband ? FLUSH : Buffer.alloc(0));
  const report: Buffer[] = [pkt(`unpack ${unpackError === null ? 'ok' : unpackError}\n`)];
  for (const result of results) report.push(pkt(result.error === null ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.error}\n`));
  report.push(FLUSH);
  const reportBytes = Buffer.concat(report);
  const out = useSideband ? Buffer.concat([...sideband(1, reportBytes), FLUSH]) : reportBytes;
  void accepted;
  return answer(200, 'application/x-git-receive-pack-result', out);
}

/** Why `command` cannot apply, or null when it can. */
function validate(repo: Repo, command: Command): string | null {
  const { old, next, ref } = command;
  if (!/^[0-9a-f]{40}$/.test(old) || !/^[0-9a-f]{40}$/.test(next)) return 'bad object id';
  if (!ref.startsWith('refs/') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref) || ref.endsWith('/') || ref.endsWith('.lock')) return 'funny refname';
  const current = repo.refs.get(ref) ?? ZERO;
  if (next === ZERO) {
    if (current === ZERO) return 'no such ref';
    if (ref === `refs/heads/${repo.defaultBranch}` && [...repo.refs.keys()].some((name) => name !== ref && name.startsWith('refs/heads/'))) {
      return 'deletion of the current branch prohibited';
    }
    if (old !== ZERO && old !== current) return 'stale info';
    return null;
  }
  const obj = store.get(next);
  if (obj === undefined) return 'missing necessary objects';
  if (ref.startsWith('refs/heads/') && obj.type !== 'commit') return 'not a commit';
  if (!connected(next)) return 'missing necessary objects';
  if (current === ZERO) {
    if (old !== ZERO) return 'stale info';
    return null;
  }
  if (current === next) return null;
  if (ref.startsWith('refs/tags/')) return 'already exists';
  if (old !== current) {
    // the client's view is out of date; whether it would fast-forward decides the words
    return isAncestor(store, current, store.peel(next)) ? 'fetch first' : 'non-fast-forward';
  }
  if (!isAncestor(store, current, store.peel(next))) return 'non-fast-forward';
  return null;
}

/** Whether every object `tip` needs is in the store (bounded: stops at commits already known complete). */
const complete = new Set<string>();
function connected(tip: string): boolean {
  const stack = [tip];
  const seen = new Set<string>();
  const visited: string[] = [];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha) || complete.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj === undefined) return false;
    if (obj.type === 'commit') {
      visited.push(sha);
      const info = store.commit(sha);
      if (info === null) return false;
      stack.push(info.tree, ...info.parents);
    } else if (obj.type === 'tree') {
      const entries = store.tree(sha);
      if (entries === null) return false;
      for (const entry of entries) if (entry.mode !== '160000') stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      const target = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m)?.[1];
      if (target === undefined) return false;
      stack.push(target);
    }
  }
  for (const sha of visited) complete.add(sha);
  return true;
}
