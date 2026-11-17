// forge.ts: the forge's state and every operation the REST, GraphQL and MCP surfaces share.
//
// One process, one in-memory store. A repository holds its refs (pointing into the shared object store),
// its issues, pull requests, labels and comments. Every surface goes through these functions, so an issue
// created over MCP is the same object REST reads, with the same id.
//
// Time: every timestamp comes from a logical clock that starts at MAKEFUN_TRIAL_NOW (or a fixed date) and
// advances one second per event, so two runs of the same requests write the same commits and dates.

import {
  ObjectStore,
  ZERO,
  buildCommit,
  buildFlatTree,
  flattenTree,
  isAncestor,
  mergeBase,
  type FlatEntry,
  type Signature,
} from './git.ts';

export class ApiError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ------------------------------------------------------------------------------------- identity and clock

/**
 * The login the trial's token names. The suite's scenario is built from one fixed seed, and its viewer is
 * this user; FORGE_LOGIN overrides it for a forge run anywhere else.
 */
export const VIEWER = {
  login: process.env.FORGE_LOGIN ?? 'adaiversen',
  id: 1000,
  name: process.env.FORGE_NAME ?? 'ada iversen',
  email: process.env.FORGE_EMAIL ?? 'adaiversen@example.invalid',
};

function startEpoch(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1767225600; // 2026-01-01T00:00:00Z
}

let clock = startEpoch();

/** The next logical second. */
export function tick(): number {
  clock += 1;
  return clock;
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ------------------------------------------------------------------------------------- the model

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  created: number;
  updated: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  comments: Comment[];
  created: number;
  updated: number;
  closed: number | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** Frozen once the pull request closes; open ones read their branches live. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: number | null;
  mergeSha: string | null;
  draft: boolean;
  created: number;
  updated: number;
  closed: number | null;
  comments: Comment[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  homepage: string | null;
  hasIssues: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  created: number;
  updated: number;
  pushed: number | null;
  nextNumber: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  /** Bumped on every ref change: keys the clone-response cache. */
  version: number;
}

export const store = new ObjectStore();
const repos = new Map<string, Repo>();
const reposById = new Map<number, Repo>();
let nextRepoId = 100000;
let nextIssueId = 200000;
let nextCommentId = 300000;
let nextLabelId = 400000;

/** Issue and pull ids are globally unique; these find an object by its database id. */
const issueIndex = new Map<number, { repo: Repo; issue: Issue }>();
const pullIndex = new Map<number, { repo: Repo; pull: Pull }>();
const commentIndex = new Map<number, { repo: Repo; comment: Comment; issue: number }>();

function key(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function isViewer(owner: string): boolean {
  return owner.toLowerCase() === VIEWER.login.toLowerCase();
}

export function findRepo(owner: string, name: string): Repo | null {
  if (!isViewer(owner)) return null;
  const clean = name.endsWith('.git') ? name.slice(0, -4) : name;
  return repos.get(key(owner, clean)) ?? null;
}

export function getRepo(owner: string, name: string): Repo {
  const repo = findRepo(owner, name);
  if (repo === null) throw new ApiError(404, 'Not Found');
  return repo;
}

export function repoById(id: number): Repo | null {
  return reposById.get(id) ?? null;
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

export function createRepo(input: { name?: unknown; description?: unknown; private?: unknown; auto_init?: unknown; homepage?: unknown; has_issues?: unknown; default_branch?: unknown }): Repo {
  const name = input.name;
  if (typeof name !== 'string' || name === '') {
    throw new ApiError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] });
  }
  if (!NAME_RE.test(name) || name === '.' || name === '..' || name.endsWith('.git')) {
    throw new ApiError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }] });
  }
  if (repos.has(key(VIEWER.login, name))) {
    throw new ApiError(422, 'Repository creation failed: name already exists on this account', {
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  const now = tick();
  const repo: Repo = {
    id: nextRepoId++,
    owner: VIEWER.login,
    name,
    description: typeof input.description === 'string' ? input.description : null,
    private: input.private === true,
    homepage: typeof input.homepage === 'string' ? input.homepage : null,
    hasIssues: input.has_issues !== false,
    defaultBranch: typeof input.default_branch === 'string' && input.default_branch !== '' ? input.default_branch : 'main',
    refs: new Map(),
    created: now,
    updated: now,
    pushed: null,
    nextNumber: 1,
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    version: 0,
  };
  repos.set(key(repo.owner, name), repo);
  reposById.set(repo.id, repo);
  if (input.auto_init === true) {
    commitFiles(repo, repo.defaultBranch, new Map([['README.md', Buffer.from(`# ${name}\n${repo.description ? `\n${repo.description}\n` : ''}`)]]), 'Initial commit');
  }
  return repo;
}

export function updateRepo(repo: Repo, input: Record<string, unknown>): Repo {
  if (typeof input.name === 'string' && input.name !== repo.name) {
    if (!NAME_RE.test(input.name)) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Repository', code: 'invalid', field: 'name' }] });
    if (repos.has(key(repo.owner, input.name))) throw new ApiError(422, 'Validation Failed: name already exists on this account');
    repos.delete(key(repo.owner, repo.name));
    repo.name = input.name;
    repos.set(key(repo.owner, repo.name), repo);
  }
  if ('description' in input) repo.description = typeof input.description === 'string' ? input.description : null;
  if ('homepage' in input) repo.homepage = typeof input.homepage === 'string' ? input.homepage : null;
  if (typeof input.private === 'boolean') repo.private = input.private;
  if (typeof input.visibility === 'string') repo.private = input.visibility !== 'public';
  if (typeof input.has_issues === 'boolean') repo.hasIssues = input.has_issues;
  if (typeof input.default_branch === 'string' && input.default_branch !== '') {
    if (repo.refs.size > 0 && !repo.refs.has(`refs/heads/${input.default_branch}`)) {
      throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Repository', code: 'invalid', field: 'default_branch' }] });
    }
    repo.defaultBranch = input.default_branch;
  }
  repo.updated = tick();
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(key(repo.owner, repo.name));
  reposById.delete(repo.id);
  for (const issue of repo.issues.values()) issueIndex.delete(issue.id);
  for (const pull of repo.pulls.values()) pullIndex.delete(pull.id);
}

// ------------------------------------------------------------------------------------- refs and commits

export function branchSha(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function setRef(repo: Repo, ref: string, sha: string | null): void {
  if (sha === null) repo.refs.delete(ref);
  else repo.refs.set(ref, sha);
  repo.version += 1;
  repo.pushed = tick();
}

/** Resolve a ref name, a branch, a tag or a commit id to a commit id. */
export function resolveRef(repo: Repo, ref: string | null | undefined): string | null {
  const name = ref === undefined || ref === null || ref === '' ? repo.defaultBranch : ref;
  const direct = repo.refs.get(name) ?? repo.refs.get(`refs/heads/${name}`) ?? repo.refs.get(`refs/tags/${name}`) ?? repo.refs.get(name.replace(/^heads\//, 'refs/heads/'));
  if (direct !== undefined) return store.peel(direct);
  if (/^[0-9a-f]{40}$/i.test(name) && store.has(name.toLowerCase())) return store.peel(name.toLowerCase());
  if (/^[0-9a-f]{7,39}$/i.test(name)) {
    for (const sha of store.objects.keys()) if (sha.startsWith(name.toLowerCase())) return store.peel(sha);
  }
  return null;
}

export function viewerSignature(): Signature {
  return { name: VIEWER.name, email: VIEWER.email, time: tick(), tz: '+0000' };
}

/** The flat file map of a commit (empty for null). */
export function filesAt(commit: string | null): Map<string, FlatEntry> {
  if (commit === null) return new Map();
  const info = store.commit(commit);
  return info === null ? new Map() : flattenTree(store, info.tree);
}

/** Write a commit on `branch` whose tree is the branch tip's with `changes` applied (null deletes a path). */
export function commitFiles(repo: Repo, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string, parentsOverride?: string[]): string {
  const tip = branchSha(repo, branch);
  const flat = filesAt(tip);
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else flat.set(path, { mode: flat.get(path)?.mode ?? '100644', sha: store.put('blob', content) });
  }
  const tree = buildFlatTree(store, flat);
  const sig = viewerSignature();
  const commit = store.put('commit', buildCommit({ tree, parents: parentsOverride ?? (tip === null ? [] : [tip]), author: sig, committer: sig, message }));
  setRef(repo, `refs/heads/${branch}`, commit);
  return commit;
}

/** After a push made the first branch of an empty repository, HEAD follows it as GitHub does. */
export function settleDefaultBranch(repo: Repo, created: readonly string[]): void {
  if (repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return;
  const heads = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/'));
  if (heads.length === 0) return;
  const pick = created.find((ref) => ref.startsWith('refs/heads/')) ?? heads[0];
  repo.defaultBranch = pick.slice('refs/heads/'.length);
}

// ------------------------------------------------------------------------------------- labels

export function createLabel(repo: Repo, input: Record<string, unknown>): Label {
  const name = input.name;
  if (typeof name !== 'string' || name.trim() === '') throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Label', code: 'missing_field', field: 'name' }] });
  if (repo.labels.has(name.toLowerCase())) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
  const color = typeof input.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(input.color) ? input.color.replace(/^#/, '').toLowerCase() : 'ededed';
  const label: Label = { id: nextLabelId++, name, color, description: typeof input.description === 'string' ? input.description : null };
  repo.labels.set(name.toLowerCase(), label);
  return label;
}

function labelNames(repo: Repo, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Issue', code: 'invalid', field: 'labels' }] });
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : null;
    if (name === null) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Issue', code: 'invalid', field: 'labels' }] });
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) {
      throw new ApiError(422, `Validation Failed: the label ${JSON.stringify(name)} does not exist`, {
        errors: [{ resource: 'Label', code: 'invalid', field: 'labels', value: name, message: `label ${name} does not exist` }],
      });
    }
    if (!names.includes(label.name)) names.push(label.name);
  }
  return names;
}

export function labelOf(repo: Repo, name: string): Label {
  return repo.labels.get(name.toLowerCase()) ?? { id: 0, name, color: 'ededed', description: null };
}

// ------------------------------------------------------------------------------------- issues

export function createIssue(repo: Repo, input: Record<string, unknown>): Issue {
  if (!repo.hasIssues) throw new ApiError(410, 'Issues are disabled for this repo');
  const title = input.title;
  if (typeof title !== 'string' && typeof title !== 'number') {
    throw new ApiError(422, 'Validation Failed: title is required', { errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] });
  }
  if (String(title).trim() === '') throw new ApiError(422, 'Validation Failed: title is required', { errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] });
  const labels = labelNames(repo, input.labels);
  const now = tick();
  const issue: Issue = {
    id: nextIssueId++,
    number: repo.nextNumber++,
    title: String(title),
    body: typeof input.body === 'string' ? input.body : null,
    state: 'open',
    stateReason: null,
    labels,
    comments: [],
    created: now,
    updated: now,
    closed: null,
  };
  repo.issues.set(issue.number, issue);
  issueIndex.set(issue.id, { repo, issue });
  return issue;
}

export function getIssue(repo: Repo, number: number): Issue {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new ApiError(404, 'Not Found');
  return issue;
}

export function updateIssue(repo: Repo, issue: Issue, input: Record<string, unknown>): Issue {
  if ('title' in input) {
    if (typeof input.title !== 'string' || input.title.trim() === '') throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] });
    issue.title = input.title;
  }
  if ('body' in input) issue.body = typeof input.body === 'string' ? input.body : null;
  if ('labels' in input) issue.labels = labelNames(repo, input.labels);
  if ('state' in input) {
    if (input.state !== 'open' && input.state !== 'closed') throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'Issue', code: 'invalid', field: 'state' }] });
    setIssueState(issue, input.state, typeof input.state_reason === 'string' ? input.state_reason : null);
  }
  issue.updated = tick();
  return issue;
}

export function setIssueState(issue: Issue, state: 'open' | 'closed', reason: string | null = null): void {
  if (state === 'closed' && issue.state !== 'closed') {
    issue.state = 'closed';
    issue.closed = tick();
    issue.stateReason = reason ?? 'completed';
  } else if (state === 'open' && issue.state !== 'open') {
    issue.state = 'open';
    issue.closed = null;
    issue.stateReason = 'reopened';
  }
  issue.updated = tick();
}

export function addComment(repo: Repo, number: number, body: unknown): Comment {
  if (typeof body !== 'string' || body === '') throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }] });
  const target = repo.issues.get(number) ?? repo.pulls.get(number);
  if (target === undefined) throw new ApiError(404, 'Not Found');
  const now = tick();
  const comment: Comment = { id: nextCommentId++, body, created: now, updated: now };
  target.comments.push(comment);
  target.updated = now;
  commentIndex.set(comment.id, { repo, comment, issue: number });
  return comment;
}

export function issueByDbId(id: number): { repo: Repo; issue: Issue } | null {
  const found = issueIndex.get(id);
  return found !== undefined && reposById.has(found.repo.id) ? found : null;
}

export function pullByDbId(id: number): { repo: Repo; pull: Pull } | null {
  const found = pullIndex.get(id);
  return found !== undefined && reposById.has(found.repo.id) ? found : null;
}

export function commentByDbId(id: number): { repo: Repo; comment: Comment; issue: number } | null {
  return commentIndex.get(id) ?? null;
}

/** Filter, sort and return a repository's issues (pull requests are not listed here). */
export function queryIssues(repo: Repo, options: { state?: string; sort?: string; direction?: string; labels?: string[] }): Issue[] {
  const state = options.state ?? 'open';
  let list = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
  if (options.labels !== undefined && options.labels.length > 0) {
    const wanted = options.labels.map((name) => name.toLowerCase());
    list = list.filter((issue) => wanted.every((name) => issue.labels.some((label) => label.toLowerCase() === name)));
  }
  const sort = options.sort ?? 'created';
  const dir = options.direction === 'asc' ? 1 : -1;
  const keyOf = (issue: Issue): number => (sort === 'updated' ? issue.updated : sort === 'comments' ? issue.comments.length : issue.created);
  list.sort((a, b) => (keyOf(a) - keyOf(b) || a.number - b.number) * dir);
  return list;
}

// ------------------------------------------------------------------------------------- pull requests

export function pullHeadSha(repo: Repo, pull: Pull): string {
  if (pull.state === 'open') return branchSha(repo, pull.head) ?? pull.headSha;
  return pull.headSha;
}

export function pullBaseSha(repo: Repo, pull: Pull): string {
  if (pull.state === 'open') return branchSha(repo, pull.base) ?? pull.baseSha;
  return pull.baseSha;
}

export function createPull(repo: Repo, input: Record<string, unknown>): Pull {
  const title = input.title;
  const headRaw = input.head;
  const base = input.base;
  if (typeof headRaw !== 'string' || headRaw === '') throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'head' }] });
  if (typeof base !== 'string' || base === '') throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'base' }] });
  const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
  const headSha = branchSha(repo, head);
  const baseSha = branchSha(repo, base);
  if (headSha === null) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head', message: `head branch ${head} does not exist` }] });
  if (baseSha === null) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'invalid', field: 'base', message: `base branch ${base} does not exist` }] });
  if (head === base) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: 'head and base must be different branches' }] });
  for (const other of repo.pulls.values()) {
    if (other.state === 'open' && other.head === head && other.base === base) {
      throw new ApiError(422, `Validation Failed: A pull request already exists for ${repo.owner}:${head}.`, { errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${repo.owner}:${head}.` }] });
    }
  }
  let finalTitle = typeof title === 'string' && title !== '' ? title : null;
  if (finalTitle === null) {
    if (typeof input.issue === 'number') finalTitle = repo.issues.get(input.issue)?.title ?? null;
    if (finalTitle === null) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }] });
  }
  const now = tick();
  const pull: Pull = {
    id: nextIssueId++,
    number: repo.nextNumber++,
    title: finalTitle,
    body: typeof input.body === 'string' ? input.body : null,
    state: 'open',
    head,
    base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeSha: null,
    draft: input.draft === true,
    created: now,
    updated: now,
    closed: null,
    comments: [],
  };
  repo.pulls.set(pull.number, pull);
  pullIndex.set(pull.id, { repo, pull });
  return pull;
}

export function getPull(repo: Repo, number: number): Pull {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new ApiError(404, 'Not Found');
  return pull;
}

export function queryPulls(repo: Repo, options: { state?: string; head?: string; base?: string; sort?: string; direction?: string }): Pull[] {
  const state = options.state ?? 'open';
  let list = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
  if (options.head !== undefined && options.head !== '') {
    const head = options.head.includes(':') ? options.head.slice(options.head.indexOf(':') + 1) : options.head;
    list = list.filter((pull) => pull.head === head);
  }
  if (options.base !== undefined && options.base !== '') list = list.filter((pull) => pull.base === options.base);
  const dir = options.direction === 'asc' ? 1 : -1;
  const keyOf = (pull: Pull): number => (options.sort === 'updated' ? pull.updated : pull.created);
  list.sort((a, b) => (keyOf(a) - keyOf(b) || a.number - b.number) * dir);
  return list;
}

export function updatePull(repo: Repo, pull: Pull, input: Record<string, unknown>): Pull {
  if (typeof input.title === 'string') pull.title = input.title;
  if ('body' in input) pull.body = typeof input.body === 'string' ? input.body : null;
  if (typeof input.base === 'string' && input.base !== pull.base) {
    if (branchSha(repo, input.base) === null) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'invalid', field: 'base' }] });
    pull.base = input.base;
  }
  if (input.state === 'closed' && pull.state === 'open') closePull(repo, pull);
  else if (input.state === 'open' && pull.state === 'closed' && !pull.merged) {
    pull.state = 'open';
    pull.closed = null;
  }
  pull.updated = tick();
  return pull;
}

export function closePull(repo: Repo, pull: Pull): void {
  pull.headSha = pullHeadSha(repo, pull);
  pull.baseSha = pullBaseSha(repo, pull);
  pull.state = 'closed';
  pull.closed = tick();
  pull.updated = pull.closed;
}

interface MergePlan {
  /** The tree the merged result carries, or null on a conflict. */
  files: Map<string, FlatEntry> | null;
  conflicts: string[];
  base: string | null;
}

/** A three-way, path-level merge of `head` into `baseTip` (the plan, nothing written). */
function planMerge(baseTip: string, head: string): MergePlan {
  const ancestor = mergeBase(store, baseTip, head);
  if (ancestor === baseTip) return { files: filesAt(head), conflicts: [], base: ancestor };
  const original = filesAt(ancestor);
  const ours = filesAt(baseTip);
  const theirs = filesAt(head);
  const result = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...original.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean => (a === undefined ? b === undefined : b !== undefined && a.sha === b.sha && a.mode === b.mode);
  for (const path of paths) {
    const o = original.get(path);
    const a = ours.get(path);
    const b = theirs.get(path);
    let pick: FlatEntry | undefined;
    if (same(a, b)) pick = a;
    else if (same(o, a)) pick = b;
    else if (same(o, b)) pick = a;
    else {
      conflicts.push(path);
      continue;
    }
    if (pick !== undefined) result.set(path, pick);
  }
  return { files: conflicts.length > 0 ? null : result, conflicts, base: ancestor };
}

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export function mergeableOf(repo: Repo, pull: Pull): Mergeable {
  if (pull.state !== 'open') return pull.merged ? 'MERGEABLE' : 'UNKNOWN';
  const head = branchSha(repo, pull.head);
  const base = branchSha(repo, pull.base);
  if (head === null || base === null) return 'CONFLICTING';
  return planMerge(base, head).files === null ? 'CONFLICTING' : 'MERGEABLE';
}

export function mergePull(repo: Repo, pull: Pull, input: Record<string, unknown>): { sha: string; message: string } {
  if (pull.merged) throw new ApiError(405, 'Pull Request is not mergeable: it is already merged');
  if (pull.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable: it is closed');
  const head = branchSha(repo, pull.head);
  const base = branchSha(repo, pull.base);
  if (head === null || base === null) throw new ApiError(405, 'Pull Request is not mergeable: a branch is missing');
  if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== head) {
    throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
  }
  const plan = planMerge(base, head);
  if (plan.files === null) throw new ApiError(405, `Pull Request is not mergeable: merge conflict in ${plan.conflicts.join(', ')}`);
  const method = typeof input.merge_method === 'string' ? input.merge_method : 'merge';
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new ApiError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'invalid', field: 'merge_method' }] });
  const title = typeof input.commit_title === 'string' && input.commit_title !== '' ? input.commit_title : method === 'merge' ? `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}` : `${pull.title} (#${pull.number})`;
  const detail = typeof input.commit_message === 'string' ? input.commit_message : method === 'merge' ? pull.title : '';
  const message = detail === '' ? `${title}\n` : `${title}\n\n${detail}\n`;
  const tree = buildFlatTree(store, plan.files);
  const sig = viewerSignature();
  const parents = method === 'merge' ? [base, head] : [base];
  const sha = store.put('commit', buildCommit({ tree, parents, author: sig, committer: sig, message }));
  setRef(repo, `refs/heads/${pull.base}`, sha);
  pull.headSha = head;
  pull.baseSha = base;
  pull.merged = true;
  pull.mergeSha = sha;
  pull.state = 'closed';
  pull.mergedAt = tick();
  pull.closed = pull.mergedAt;
  pull.updated = pull.mergedAt;
  return { sha, message: 'Pull Request successfully merged' };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  patch: string;
}

function lineCounts(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number; patch: string } {
  const split = (buf: Buffer | null): string[] => {
    if (buf === null || buf.length === 0) return [];
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = split(before);
  const b = split(after);
  // common prefix and suffix, then a multiset match of the middles: exact for the usual edits, cheap always
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const counts = new Map<string, number>();
  for (let i = start; i < endA; i += 1) counts.set(a[i], (counts.get(a[i]) ?? 0) + 1);
  let additions = 0;
  const added: string[] = [];
  for (let i = start; i < endB; i += 1) {
    const left = counts.get(b[i]) ?? 0;
    if (left > 0) counts.set(b[i], left - 1);
    else {
      additions += 1;
      added.push(b[i]);
    }
  }
  let deletions = 0;
  const removed: string[] = [];
  for (let i = start; i < endA; i += 1) {
    const left = counts.get(a[i]) ?? 0;
    if (left > 0) {
      deletions += 1;
      counts.set(a[i], left - 1);
      removed.push(a[i]);
    }
  }
  const hunk = `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`;
  const patch = [hunk, ...removed.slice(0, 200).map((line) => `-${line}`), ...added.slice(0, 200).map((line) => `+${line}`)].join('\n');
  return { additions, deletions, patch };
}

/** The files a pull request changes: its head against the merge base with its base branch. */
export function pullFiles(repo: Repo, pull: Pull): ChangedFile[] {
  const head = pullHeadSha(repo, pull);
  const base = pullBaseSha(repo, pull);
  const ancestor = pull.merged ? mergeBase(store, pull.baseSha, head) : mergeBase(store, base, head);
  return diffCommits(ancestor, head);
}

export function diffCommits(from: string | null, to: string | null): ChangedFile[] {
  const before = filesAt(from);
  const after = filesAt(to);
  const files: ChangedFile[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    if (a !== undefined && b !== undefined && a.sha === b.sha) continue;
    const counts = lineCounts(a === undefined ? null : store.get(a.sha)?.data ?? null, b === undefined ? null : store.get(b.sha)?.data ?? null);
    files.push({
      filename: path,
      status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: (b ?? a)?.sha ?? ZERO,
      patch: counts.patch,
    });
  }
  return files;
}

/** Commits on `head` not on `base`, oldest first. */
export function pullCommits(repo: Repo, pull: Pull): string[] {
  const head = pullHeadSha(repo, pull);
  const base = pull.merged ? pull.baseSha : pullBaseSha(repo, pull);
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [head];
  while (queue.length > 0 && out.length < 250) {
    const sha = queue.shift() as string;
    if (seen.has(sha) || isAncestor(store, sha, base)) continue;
    seen.add(sha);
    out.push(sha);
    const info = store.commit(sha);
    if (info !== null) queue.push(...info.parents);
  }
  return out.reverse();
}

/** Commits reachable from `tip`, newest first by committer time, then walk order. */
export function history(tip: string, limit: number, path?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([tip]);
  const frontier = [tip];
  while (frontier.length > 0 && out.length < limit) {
    frontier.sort((a, b) => (store.commit(b)?.committer.time ?? 0) - (store.commit(a)?.committer.time ?? 0));
    const sha = frontier.shift() as string;
    const info = store.commit(sha);
    if (info === null) continue;
    if (path === undefined || touches(sha, path)) out.push(sha);
    for (const parent of info.parents) {
      if (!seen.has(parent) && store.has(parent)) {
        seen.add(parent);
        frontier.push(parent);
      }
    }
  }
  return out;
}

function touches(sha: string, path: string): boolean {
  const info = store.commit(sha);
  if (info === null) return false;
  const now = filesAt(sha);
  const prefix = `${path.replace(/\/+$/, '')}/`;
  const parent = info.parents[0] ?? null;
  const before = filesAt(parent);
  for (const [file, entry] of now) if ((file === path || file.startsWith(prefix)) && before.get(file)?.sha !== entry.sha) return true;
  for (const file of before.keys()) if ((file === path || file.startsWith(prefix)) && !now.has(file)) return true;
  return false;
}
