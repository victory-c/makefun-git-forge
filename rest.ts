// rest.ts: the GitHub REST v3 surface under /api/v3, over forge.ts.
//
// route() takes a parsed request and answers {status, body, headers}. Every error is a JSON body with a
// string message; main.ts adds the request id and the content type to every answer.

import {
  ApiError,
  VIEWER,
  addComment,
  branchSha,
  commitFiles,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteRepo,
  diffCommits,
  filesAt,
  getIssue,
  getPull,
  getRepo,
  history,
  isoOf,
  labelOf,
  listRepos,
  mergePull,
  mergeableOf,
  pullBaseSha,
  pullCommits,
  pullFiles,
  pullHeadSha,
  queryIssues,
  queryPulls,
  resolveRef,
  setRef,
  store,
  updateIssue,
  updatePull,
  updateRepo,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './forge.ts';
import { flattenTree, isAncestor, parseTag, ZERO } from './git.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  base: string;
}

export interface RestAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type Json = Record<string, unknown>;

// ------------------------------------------------------------------------------------- ids and urls

/** An opaque, stable global id: a type prefix and the base64 of the kind and database id. */
const nodeIdCache = new Map<string, string>();
export function nodeId(kind: string, id: number): string {
  const key = `${kind}:${id}`;
  let value = nodeIdCache.get(key);
  if (value === undefined) {
    value = `${NODE_PREFIX[kind] ?? 'N_'}${Buffer.from(key).toString('base64url')}`;
    nodeIdCache.set(key, value);
  }
  return value;
}

const NODE_PREFIX: Record<string, string> = { Repository: 'R_kgDO', Issue: 'I_kwDO', PullRequest: 'PR_kwDO', IssueComment: 'IC_kwDO', User: 'U_kgDO', Label: 'LA_kwDO' };

export function decodeNodeId(id: string): { kind: string; id: number } | null {
  const at = id.indexOf('_kwDO') >= 0 ? id.indexOf('_kwDO') + 5 : id.indexOf('_kgDO') >= 0 ? id.indexOf('_kgDO') + 5 : id.startsWith('N_') ? 2 : -1;
  if (at < 0) return null;
  const text = Buffer.from(id.slice(at), 'base64url').toString('utf8');
  const match = /^([A-Za-z]+):(\d+)$/.exec(text);
  return match === null ? null : { kind: match[1], id: Number(match[2]) };
}

const userCache = new Map<string, Json>();

/** The viewer as GitHub's simple-user object (one shared, frozen object per origin). */
export function userJson(base: string): Json {
  const cached = userCache.get(base);
  if (cached !== undefined) return cached;
  const user = Object.freeze({
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: nodeId('User', VIEWER.id),
    avatar_url: `${base}/avatars/${VIEWER.login}`,
    gravatar_id: '',
    url: `${base}/api/v3/users/${VIEWER.login}`,
    html_url: `${base}/${VIEWER.login}`,
    repos_url: `${base}/api/v3/users/${VIEWER.login}/repos`,
    type: 'User',
    site_admin: false,
  });
  userCache.set(base, user);
  return user;
}

export function repoJson(repo: Repo, base: string): Json {
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    visibility: repo.private ? 'private' : 'public',
    owner: userJson(base),
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: api,
    git_url: `${base}/${repo.owner}/${repo.name}.git`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge:${repo.owner}/${repo.name}.git`,
    homepage: repo.homepage,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    open_issues: openIssues,
    has_issues: repo.hasIssues,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: false,
    archived: false,
    disabled: false,
    is_template: false,
    topics: [],
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    created_at: isoOf(repo.created),
    updated_at: isoOf(repo.updated),
    pushed_at: repo.pushed === null ? null : isoOf(repo.pushed),
    issues_url: `${api}/issues{/number}`,
    pulls_url: `${api}/pulls{/number}`,
    contents_url: `${api}/contents/{+path}`,
  };
}

export function labelJson(repo: Repo, label: Label, base: string): Json {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue, base: string): Json {
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    url: `${api}/issues/${issue.number}`,
    repository_url: api,
    comments_url: `${api}/issues/${issue.number}/comments`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    state_reason: issue.stateReason,
    title: issue.title,
    body: issue.body,
    user: userJson(base),
    labels: issue.labels.map((name) => labelJson(repo, labelOf(repo, name), base)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: isoOf(issue.created),
    updated_at: isoOf(issue.updated),
    closed_at: issue.closed === null ? null : isoOf(issue.closed),
    author_association: 'OWNER',
  };
}

export function commentJson(repo: Repo, number: number, comment: Comment, base: string): Json {
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    url: `${api}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    issue_url: `${api}/issues/${number}`,
    body: comment.body,
    user: userJson(base),
    created_at: isoOf(comment.created),
    updated_at: isoOf(comment.updated),
    author_association: 'OWNER',
  };
}

function branchRef(repo: Repo, ref: string, sha: string, base: string): Json {
  return { label: `${repo.owner}:${ref}`, ref, sha, user: userJson(base), repo: repoJson(repo, base) };
}

export function pullJson(repo: Repo, pull: Pull, base: string, full = true): Json {
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const head = pullHeadSha(repo, pull);
  const baseSha = pullBaseSha(repo, pull);
  const out: Json = {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    url: `${api}/pulls/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    issue_url: `${api}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(base),
    labels: [],
    created_at: isoOf(pull.created),
    updated_at: isoOf(pull.updated),
    closed_at: pull.closed === null ? null : isoOf(pull.closed),
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeSha,
    draft: pull.draft,
    head: branchRef(repo, pull.head, head, base),
    base: branchRef(repo, pull.base, baseSha, base),
    author_association: 'OWNER',
    merged: pull.merged,
  };
  if (full) {
    const mergeable = mergeableOf(repo, pull);
    const files = pullFiles(repo, pull);
    out.mergeable = pull.state === 'open' ? mergeable === 'MERGEABLE' : null;
    out.mergeable_state = pull.state === 'open' ? (mergeable === 'MERGEABLE' ? 'clean' : 'dirty') : 'unknown';
    out.merged_by = pull.merged ? userJson(base) : null;
    out.comments = pull.comments.length;
    out.commits = pullCommits(repo, pull).length;
    out.additions = files.reduce((sum, file) => sum + file.additions, 0);
    out.deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    out.changed_files = files.length;
  }
  return out;
}

export function commitJson(repo: Repo, sha: string, base: string, withFiles = false): Json {
  const info = store.commit(sha);
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  if (info === null) return { sha };
  const person = (sig: { name: string; email: string; time: number }) => ({ name: sig.name, email: sig.email, date: isoOf(sig.time) });
  const out: Json = {
    sha,
    node_id: `C_${Buffer.from(sha, 'hex').toString('base64url')}`,
    url: `${api}/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    commit: {
      message: info.message.replace(/\n+$/, ''),
      author: person(info.author),
      committer: person(info.committer),
      tree: { sha: info.tree, url: `${api}/git/trees/${info.tree}` },
      url: `${api}/git/commits/${sha}`,
      comment_count: 0,
    },
    author: info.author.email === VIEWER.email ? userJson(base) : null,
    committer: info.committer.email === VIEWER.email ? userJson(base) : null,
    parents: info.parents.map((parent) => ({ sha: parent, url: `${api}/commits/${parent}` })),
  };
  if (withFiles) {
    const files = diffCommits(info.parents[0] ?? null, sha);
    out.files = files;
    out.stats = { additions: files.reduce((s, f) => s + f.additions, 0), deletions: files.reduce((s, f) => s + f.deletions, 0), total: files.reduce((s, f) => s + f.changes, 0) };
  }
  return out;
}

// ------------------------------------------------------------------------------------- helpers

function obj(body: unknown): Json {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Problems parsing JSON: the body must be a JSON object');
  return body as Json;
}

function pageOf(req: RestRequest, list: unknown[], defaultPer = 30): RestAnswer {
  const per = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? defaultPer) || defaultPer));
  const page = Math.max(1, Number(req.query.get('page') ?? 1) || 1);
  const slice = list.slice((page - 1) * per, page * per);
  const last = Math.max(1, Math.ceil(list.length / per));
  const links: string[] = [];
  const url = (n: number): string => {
    const query = new URLSearchParams(req.query);
    query.set('per_page', String(per));
    query.set('page', String(n));
    return `<${req.base}/api/v3${req.path}?${query.toString()}>`;
  };
  if (page < last) links.push(`${url(page + 1)}; rel="next"`, `${url(last)}; rel="last"`);
  if (page > 1) links.push(`${url(1)}; rel="first"`, `${url(page - 1)}; rel="prev"`);
  return { status: 200, body: slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

function decodeContent(raw: unknown): Buffer {
  if (typeof raw !== 'string') throw new ApiError(422, 'Invalid request.\n\n"content" wasn\'t supplied.', { errors: [{ resource: 'Content', code: 'missing_field', field: 'content' }] });
  const clean = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new ApiError(422, 'Invalid request.\n\ncontent is not valid Base64');
  return Buffer.from(clean, 'base64');
}

function contentFileJson(repo: Repo, path: string, sha: string, size: number, base: string, ref: string, withContent: Buffer | null): Json {
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const out: Json = {
    type: 'file',
    name,
    path,
    sha,
    size,
    url: `${api}/contents/${path}?ref=${ref}`,
    html_url: `${base}/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
    git_url: `${api}/git/blobs/${sha}`,
    download_url: `${base}/${repo.owner}/${repo.name}/raw/${ref}/${path}`,
    encoding: 'base64',
  };
  if (withContent !== null) out.content = withContent.toString('base64');
  out._links = { self: out.url, git: out.git_url, html: out.html_url };
  return out;
}

function intParam(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new ApiError(404, 'Not Found');
  return Number(raw);
}

// ------------------------------------------------------------------------------------- contents

function getContents(repo: Repo, path: string, req: RestRequest): RestAnswer {
  const refName = req.query.get('ref') ?? repo.defaultBranch;
  const commit = resolveRef(repo, refName);
  if (commit === null) {
    if (repo.refs.size === 0) throw new ApiError(404, 'This repository is empty.');
    throw new ApiError(404, `No commit found for the ref ${refName}`);
  }
  const flat = filesAt(commit);
  const clean = path.replace(/^\/+|\/+$/g, '');
  const file = flat.get(clean);
  if (file !== undefined) {
    const data = store.get(file.sha)?.data ?? Buffer.alloc(0);
    return { status: 200, body: contentFileJson(repo, clean, file.sha, data.length, req.base, refName, data) };
  }
  // a directory: every direct child, files and subdirectories
  const prefix = clean === '' ? '' : `${clean}/`;
  const info = store.commit(commit);
  let treeSha = info?.tree ?? null;
  if (clean !== '' && treeSha !== null) {
    for (const part of clean.split('/')) {
      const entries = store.tree(treeSha as string) ?? [];
      const hit = entries.find((entry) => entry.name === part && (entry.mode === '40000' || entry.mode === '040000'));
      treeSha = hit === undefined ? null : hit.sha;
      if (treeSha === null) break;
    }
  }
  if (treeSha === null) throw new ApiError(404, 'Not Found');
  const api = `${req.base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const list = (store.tree(treeSha) ?? []).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const childPath = `${prefix}${entry.name}`;
    const size = isDir ? 0 : store.get(entry.sha)?.data.length ?? 0;
    return {
      type: isDir ? 'dir' : entry.mode === '120000' ? 'symlink' : 'file',
      name: entry.name,
      path: childPath,
      sha: entry.sha,
      size,
      url: `${api}/contents/${childPath}?ref=${refName}`,
      html_url: `${req.base}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${refName}/${childPath}`,
      git_url: `${api}/git/${isDir ? 'trees' : 'blobs'}/${entry.sha}`,
      download_url: isDir ? null : `${req.base}/${repo.owner}/${repo.name}/raw/${refName}/${childPath}`,
    };
  });
  return { status: 200, body: list };
}

function ensureBranch(repo: Repo, branch: string): void {
  if (branchSha(repo, branch) !== null || repo.refs.size === 0) return;
  // GitHub refuses an unknown branch; creating it from the default branch keeps an agent's write useful
  const from = branchSha(repo, repo.defaultBranch);
  if (from === null) throw new ApiError(404, `Branch ${branch} not found`);
  setRef(repo, `refs/heads/${branch}`, from);
}

function putContents(repo: Repo, path: string, req: RestRequest): RestAnswer {
  const body = obj(req.body);
  if (typeof body.message !== 'string' || body.message === '') throw new ApiError(422, 'Invalid request.\n\n"message" wasn\'t supplied.', { errors: [{ resource: 'Content', code: 'missing_field', field: 'message' }] });
  const content = decodeContent(body.content);
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '' || clean.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.git')) throw new ApiError(422, 'path is invalid');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  ensureBranch(repo, branch);
  const tip = branchSha(repo, branch);
  const flat = filesAt(tip);
  const existing = flat.get(clean);
  const given = typeof body.sha === 'string' ? body.sha : null;
  if (existing !== undefined) {
    if (given === null) throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.', { errors: [{ resource: 'Content', code: 'missing_field', field: 'sha' }] });
    if (given !== existing.sha) throw new ApiError(409, `${clean} does not match ${given}`);
  } else {
    for (const other of flat.keys()) if (other.startsWith(`${clean}/`)) throw new ApiError(422, `${clean} is a directory`);
  }
  const commit = commitFiles(repo, branch, new Map([[clean, content]]), body.message);
  const blob = filesAt(commit).get(clean);
  return {
    status: existing === undefined ? 201 : 200,
    body: {
      content: contentFileJson(repo, clean, blob?.sha ?? ZERO, content.length, req.base, branch, null),
      commit: gitCommitJson(repo, commit, req.base),
    },
  };
}

function deleteContents(repo: Repo, path: string, req: RestRequest): RestAnswer {
  const body = obj(req.body);
  const clean = path.replace(/^\/+|\/+$/g, '');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = branchSha(repo, branch);
  if (tip === null) throw new ApiError(404, 'Not Found');
  const existing = filesAt(tip).get(clean);
  if (existing === undefined) throw new ApiError(404, 'Not Found');
  if (typeof body.message !== 'string' || body.message === '') throw new ApiError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  if (typeof body.sha !== 'string') throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
  if (body.sha !== existing.sha) throw new ApiError(409, `${clean} does not match ${body.sha}`);
  const commit = commitFiles(repo, branch, new Map([[clean, null]]), body.message);
  return { status: 200, body: { content: null, commit: gitCommitJson(repo, commit, req.base) } };
}

function gitCommitJson(repo: Repo, sha: string, base: string): Json {
  const info = store.commit(sha);
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  if (info === null) return { sha };
  const person = (sig: { name: string; email: string; time: number }) => ({ name: sig.name, email: sig.email, date: isoOf(sig.time) });
  return {
    sha,
    node_id: `C_${Buffer.from(sha, 'hex').toString('base64url')}`,
    url: `${api}/git/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    author: person(info.author),
    committer: person(info.committer),
    message: info.message.replace(/\n+$/, ''),
    tree: { sha: info.tree, url: `${api}/git/trees/${info.tree}` },
    parents: info.parents.map((parent) => ({ sha: parent, url: `${api}/git/commits/${parent}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

// ------------------------------------------------------------------------------------- refs

function refJson(repo: Repo, ref: string, sha: string, base: string): Json {
  const obj = store.get(sha);
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return { ref, node_id: `REF_${Buffer.from(`${repo.id}:${ref}`).toString('base64url')}`, url: `${api}/git/${ref}`, object: { sha, type: obj?.type ?? 'commit', url: `${api}/git/${obj?.type ?? 'commit'}s/${sha}` } };
}

function createRefRoute(repo: Repo, req: RestRequest): RestAnswer {
  const body = obj(req.body);
  const ref = body.ref;
  const sha = body.sha;
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.split('/').length < 3) throw new ApiError(422, 'Reference name must start with \'refs/\' and have at least two slashes.');
  if (typeof sha !== 'string' || !store.has(sha)) throw new ApiError(422, 'Object does not exist');
  if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
  setRef(repo, ref, sha);
  if (ref.startsWith('refs/heads/') && repo.refs.size === 1) repo.defaultBranch = ref.slice(11);
  return { status: 201, body: refJson(repo, ref, sha, req.base) };
}

function branchJson(repo: Repo, name: string, sha: string, base: string, full: boolean): Json {
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  if (!full) return { name, commit: { sha, url: `${api}/commits/${sha}` }, protected: false };
  return { name, commit: commitJson(repo, sha, base), protected: false, _links: { self: `${api}/branches/${name}`, html: `${base}/${repo.owner}/${repo.name}/tree/${name}` } };
}

// ------------------------------------------------------------------------------------- the router

type Handler = (req: RestRequest, params: string[]) => RestAnswer;

/**
 * The routes as a segment trie: a literal segment, one parameter segment ({name}) or a tail ({rest}, every
 * remaining segment joined by '/'). Literals win over parameters, as the old ordered table did; a lookup costs
 * one map read per path segment.
 */
interface TrieNode {
  literal: Map<string, TrieNode>;
  param: TrieNode | null;
  rest: Map<string, Handler> | null;
  handlers: Map<string, Handler>;
}

const newNode = (): TrieNode => ({ literal: new Map(), param: null, rest: null, handlers: new Map() });
const trie = newNode();

function on(method: string, pattern: string, handler: Handler): void {
  let node = trie;
  for (const segment of pattern.split('/').filter(Boolean)) {
    if (segment === '{rest}') {
      node.rest ??= new Map();
      if (!node.rest.has(method)) node.rest.set(method, handler);
      return;
    }
    if (segment.startsWith('{')) {
      node.param ??= newNode();
      node = node.param;
    } else {
      let next = node.literal.get(segment);
      if (next === undefined) {
        next = newNode();
        node.literal.set(segment, next);
      }
      node = next;
    }
  }
  if (!node.handlers.has(method)) node.handlers.set(method, handler);
}

/** Find the handlers for `segments` (literal first, then parameter, then a tail), with the captured params. */
function lookup(node: TrieNode, segments: string[], index: number, params: string[]): { handlers: Map<string, Handler>; params: string[] } | null {
  if (index === segments.length) {
    if (node.handlers.size > 0) return { handlers: node.handlers, params };
    if (node.rest !== null) return { handlers: node.rest, params: [...params, ''] };
    return null;
  }
  const segment = segments[index];
  const literal = node.literal.get(segment);
  if (literal !== undefined) {
    const found = lookup(literal, segments, index + 1, params);
    if (found !== null) return found;
  }
  if (node.param !== null) {
    const found = lookup(node.param, segments, index + 1, [...params, segment]);
    if (found !== null) return found;
  }
  if (node.rest !== null) return { handlers: node.rest, params: [...params, segments.slice(index).join('/')] };
  return null;
}

const R = '/repos/{owner}/{repo}';

on('GET', '', (req) => ({
  status: 200,
  body: {
    current_user_url: `${req.base}/api/v3/user`,
    repository_url: `${req.base}/api/v3/repos/{owner}/{repo}`,
    user_repositories_url: `${req.base}/api/v3/user/repos`,
    issues_url: `${req.base}/api/v3/issues`,
    rate_limit_url: `${req.base}/api/v3/rate_limit`,
  },
}));
on('GET', '/meta', () => ({ status: 200, body: { verifiable_password_authentication: false, installed_version: '3.14.0', ssh_key_fingerprints: {}, hooks: [], git: [], web: [], api: [] } }));
on('GET', '/rate_limit', () => ({ status: 200, body: { resources: { core: { limit: 5000, remaining: 5000, reset: 0, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0, used: 0 } } }));
on('GET', '/user', (req) => ({ status: 200, body: { ...userJson(req.base), name: VIEWER.name, email: VIEWER.email, public_repos: listRepos().length } }));
on('GET', '/users/{login}', (req, [login]) => {
  if (login.toLowerCase() !== VIEWER.login.toLowerCase()) throw new ApiError(404, 'Not Found');
  return { status: 200, body: { ...userJson(req.base), name: VIEWER.name } };
});
on('GET', '/user/repos', (req) => {
  let list = listRepos();
  const visibility = req.query.get('visibility');
  if (visibility === 'public') list = list.filter((repo) => !repo.private);
  if (visibility === 'private') list = list.filter((repo) => repo.private);
  return pageOf(req, list.map((repo) => repoJson(repo, req.base)));
});
on('GET', '/users/{login}/repos', (req, [login]) => {
  if (login.toLowerCase() !== VIEWER.login.toLowerCase()) throw new ApiError(404, 'Not Found');
  return pageOf(req, listRepos().map((repo) => repoJson(repo, req.base)));
});
on('POST', '/user/repos', (req) => ({ status: 201, body: repoJson(createRepo(obj(req.body)), req.base) }));

on('GET', R, (req, [o, r]) => ({ status: 200, body: repoJson(getRepo(o, r), req.base) }));
on('PATCH', R, (req, [o, r]) => ({ status: 200, body: repoJson(updateRepo(getRepo(o, r), obj(req.body)), req.base) }));
on('DELETE', R, (_req, [o, r]) => {
  deleteRepo(getRepo(o, r));
  return { status: 204, body: null };
});

// branches, refs and commits
on('GET', `${R}/branches`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  const list = [...repo.refs.entries()].filter(([ref]) => ref.startsWith('refs/heads/')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => branchJson(repo, ref.slice(11), sha, req.base, false));
  return pageOf(req, list);
});
on('GET', `${R}/branches/{rest}`, (req, [o, r, name]) => {
  const repo = getRepo(o, r);
  const branch = decodeURIComponent(name);
  const sha = branchSha(repo, branch);
  if (sha === null) throw new ApiError(404, 'Branch not found');
  return { status: 200, body: branchJson(repo, branch, sha, req.base, true) };
});
on('POST', `${R}/git/refs`, (req, [o, r]) => createRefRoute(getRepo(o, r), req));
on('GET', `${R}/git/refs`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  return pageOf(req, [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => refJson(repo, ref, sha, req.base)), 100);
});
for (const kind of ['refs', 'ref', 'matching-refs']) {
  on('GET', `${R}/git/${kind}/{rest}`, (req, [o, r, rest]) => {
    const repo = getRepo(o, r);
    const ref = `refs/${decodeURIComponent(rest)}`;
    if (kind === 'matching-refs') {
      return { status: 200, body: [...repo.refs.entries()].filter(([name]) => name.startsWith(ref)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, sha]) => refJson(repo, name, sha, req.base)) };
    }
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      const matches = [...repo.refs.entries()].filter(([name]) => name.startsWith(`${ref}/`));
      if (kind === 'refs' && matches.length > 0) return { status: 200, body: matches.map(([name, value]) => refJson(repo, name, value, req.base)) };
      throw new ApiError(404, 'Not Found');
    }
    return { status: 200, body: refJson(repo, ref, sha, req.base) };
  });
}
on('PATCH', `${R}/git/refs/{rest}`, (req, [o, r, rest]) => {
  const repo = getRepo(o, r);
  const ref = `refs/${decodeURIComponent(rest)}`;
  const current = repo.refs.get(ref);
  if (current === undefined) throw new ApiError(422, 'Reference does not exist');
  const body = obj(req.body);
  if (typeof body.sha !== 'string' || !store.has(body.sha)) throw new ApiError(422, 'Object does not exist');
  if (body.force !== true && !isAncestor(store, current, body.sha)) throw new ApiError(422, 'Update is not a fast forward');
  setRef(repo, ref, body.sha);
  return { status: 200, body: refJson(repo, ref, body.sha, req.base) };
});
on('DELETE', `${R}/git/refs/{rest}`, (_req, [o, r, rest]) => {
  const repo = getRepo(o, r);
  const ref = `refs/${decodeURIComponent(rest)}`;
  if (!repo.refs.has(ref)) throw new ApiError(422, 'Reference does not exist');
  setRef(repo, ref, null);
  return { status: 204, body: null };
});
on('GET', `${R}/git/commits/{sha}`, (req, [o, r, sha]) => {
  const repo = getRepo(o, r);
  if (store.get(sha)?.type !== 'commit') throw new ApiError(404, 'Not Found');
  return { status: 200, body: gitCommitJson(repo, sha, req.base) };
});
on('GET', `${R}/git/trees/{rest}`, (req, [o, r, rest]) => {
  const repo = getRepo(o, r);
  const target = resolveRef(repo, decodeURIComponent(rest));
  let tree = target !== null && store.get(target)?.type === 'commit' ? store.commit(target)?.tree ?? null : null;
  if (tree === null && store.get(rest)?.type === 'tree') tree = rest;
  if (tree === null) throw new ApiError(404, 'Not Found');
  const api = `${req.base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const entries: Json[] = [];
  if (req.query.get('recursive') !== null && req.query.get('recursive') !== '0' && req.query.get('recursive') !== 'false') {
    const walk = (sha: string, prefix: string): void => {
      for (const entry of store.tree(sha) ?? []) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const isDir = entry.mode === '40000' || entry.mode === '040000';
        entries.push({ path, mode: isDir ? '040000' : entry.mode, type: isDir ? 'tree' : 'blob', sha: entry.sha, size: isDir ? undefined : store.get(entry.sha)?.data.length ?? 0, url: `${api}/git/${isDir ? 'trees' : 'blobs'}/${entry.sha}` });
        if (isDir) walk(entry.sha, path);
      }
    };
    walk(tree, '');
  } else {
    for (const entry of store.tree(tree) ?? []) {
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      entries.push({ path: entry.name, mode: isDir ? '040000' : entry.mode, type: isDir ? 'tree' : 'blob', sha: entry.sha, size: isDir ? undefined : store.get(entry.sha)?.data.length ?? 0, url: `${api}/git/${isDir ? 'trees' : 'blobs'}/${entry.sha}` });
    }
  }
  return { status: 200, body: { sha: tree, url: `${api}/git/trees/${tree}`, tree: entries, truncated: false } };
});
on('GET', `${R}/git/blobs/{sha}`, (req, [o, r, sha]) => {
  const repo = getRepo(o, r);
  const blob = store.get(sha);
  if (blob === undefined || blob.type !== 'blob') throw new ApiError(404, 'Not Found');
  return { status: 200, body: { sha, node_id: `B_${Buffer.from(sha, 'hex').toString('base64url')}`, size: blob.data.length, url: `${req.base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`, content: blob.data.toString('base64'), encoding: 'base64' } };
});
on('GET', `${R}/git/tags/{sha}`, (req, [o, r, sha]) => {
  getRepo(o, r);
  const tag = store.get(sha);
  if (tag === undefined || tag.type !== 'tag') throw new ApiError(404, 'Not Found');
  const parsed = parseTag(tag.data);
  return { status: 200, body: { sha, tag: parsed.tag, message: parsed.message, object: { sha: parsed.object, type: parsed.type } } };
});
on('GET', `${R}/tags`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  const list = [...repo.refs.entries()].filter(([ref]) => ref.startsWith('refs/tags/')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({ name: ref.slice(10), commit: { sha: store.peel(sha) } }));
  return pageOf(req, list);
});
on('GET', `${R}/commits`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  const ref = req.query.get('sha');
  const tip = resolveRef(repo, ref);
  if (tip === null) {
    if (repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty.');
    throw new ApiError(404, `No commit found for SHA: ${ref}`);
  }
  const per = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? 1) || 1);
  const path = req.query.get('path') ?? undefined;
  const shas = history(tip, page * per + 1, path === '' ? undefined : path);
  const answer = pageOf(req, shas.map((sha) => sha), per);
  return { ...answer, body: (answer.body as string[]).map((sha) => commitJson(repo, sha, req.base)) };
});
on('GET', `${R}/commits/{rest}`, (req, [o, r, rest]) => {
  const repo = getRepo(o, r);
  const sha = resolveRef(repo, decodeURIComponent(rest));
  if (sha === null || store.get(sha)?.type !== 'commit') throw new ApiError(422, `No commit found for SHA: ${rest}`);
  return { status: 200, body: commitJson(repo, sha, req.base, true) };
});
on('GET', `${R}/compare/{rest}`, (req, [o, r, rest]) => {
  const repo = getRepo(o, r);
  const [left, right] = decodeURIComponent(rest).split('...');
  const a = resolveRef(repo, left);
  const b = resolveRef(repo, right ?? '');
  if (a === null || b === null) throw new ApiError(404, 'Not Found');
  const files = diffCommits(a, b);
  return { status: 200, body: { status: a === b ? 'identical' : isAncestor(store, a, b) ? 'ahead' : 'diverged', files, base_commit: commitJson(repo, a, req.base), commits: [] } };
});

// contents
on('GET', `${R}/readme`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  const commit = resolveRef(repo, req.query.get('ref'));
  const flat = filesAt(commit);
  const name = [...flat.keys()].find((path) => /^readme(\.|$)/i.test(path));
  if (name === undefined) throw new ApiError(404, 'Not Found');
  return getContents(repo, name, req);
});
on('GET', `${R}/contents`, (req, [o, r]) => getContents(getRepo(o, r), '', req));
on('GET', `${R}/contents/{rest}`, (req, [o, r, rest]) => getContents(getRepo(o, r), decodeURIComponent(rest), req));
on('PUT', `${R}/contents/{rest}`, (req, [o, r, rest]) => putContents(getRepo(o, r), decodeURIComponent(rest), req));
on('DELETE', `${R}/contents/{rest}`, (req, [o, r, rest]) => deleteContents(getRepo(o, r), decodeURIComponent(rest), req));

// labels
on('GET', `${R}/labels`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  return pageOf(req, [...repo.labels.values()].map((label) => labelJson(repo, label, req.base)));
});
on('POST', `${R}/labels`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  return { status: 201, body: labelJson(repo, createLabel(repo, obj(req.body)), req.base) };
});
on('GET', `${R}/labels/{name}`, (req, [o, r, name]) => {
  const repo = getRepo(o, r);
  const label = repo.labels.get(decodeURIComponent(name).toLowerCase());
  if (label === undefined) throw new ApiError(404, 'Not Found');
  return { status: 200, body: labelJson(repo, label, req.base) };
});
on('PATCH', `${R}/labels/{name}`, (req, [o, r, name]) => {
  const repo = getRepo(o, r);
  const label = repo.labels.get(decodeURIComponent(name).toLowerCase());
  if (label === undefined) throw new ApiError(404, 'Not Found');
  const body = obj(req.body);
  if (typeof body.color === 'string') label.color = body.color.replace(/^#/, '');
  if (typeof body.description === 'string') label.description = body.description;
  if (typeof body.new_name === 'string' && body.new_name !== '') {
    repo.labels.delete(label.name.toLowerCase());
    for (const issue of repo.issues.values()) issue.labels = issue.labels.map((n) => (n === label.name ? (body.new_name as string) : n));
    label.name = body.new_name;
    repo.labels.set(label.name.toLowerCase(), label);
  }
  return { status: 200, body: labelJson(repo, label, req.base) };
});
on('DELETE', `${R}/labels/{name}`, (_req, [o, r, name]) => {
  const repo = getRepo(o, r);
  const label = repo.labels.get(decodeURIComponent(name).toLowerCase());
  if (label === undefined) throw new ApiError(404, 'Not Found');
  repo.labels.delete(label.name.toLowerCase());
  for (const issue of repo.issues.values()) issue.labels = issue.labels.filter((n) => n !== label.name);
  return { status: 204, body: null };
});

// issues
on('GET', `${R}/issues`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  const labels = req.query.get('labels');
  const list = queryIssues(repo, {
    state: req.query.get('state') ?? 'open',
    sort: req.query.get('sort') ?? 'created',
    direction: req.query.get('direction') ?? 'desc',
    labels: labels === null || labels === '' ? undefined : labels.split(','),
  });
  return pageOf(req, list.map((issue) => issueJson(repo, issue, req.base)));
});
on('POST', `${R}/issues`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  return { status: 201, body: issueJson(repo, createIssue(repo, obj(req.body)), req.base) };
});
on('GET', `${R}/issues/comments/{id}`, (req, [o, r, id]) => {
  const repo = getRepo(o, r);
  for (const issue of [...repo.issues.values(), ...repo.pulls.values()]) {
    const comment = issue.comments.find((c) => c.id === Number(id));
    if (comment !== undefined) return { status: 200, body: commentJson(repo, issue.number, comment, req.base) };
  }
  throw new ApiError(404, 'Not Found');
});
on('GET', `${R}/issues/{number}`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const number = intParam(n);
  const pull = repo.pulls.get(number);
  if (pull !== undefined) {
    return { status: 200, body: { ...pullAsIssue(repo, pull, req.base) } };
  }
  return { status: 200, body: issueJson(repo, getIssue(repo, number), req.base) };
});
on('PATCH', `${R}/issues/{number}`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const number = intParam(n);
  const pull = repo.pulls.get(number);
  if (pull !== undefined) {
    updatePull(repo, pull, obj(req.body));
    return { status: 200, body: pullAsIssue(repo, pull, req.base) };
  }
  const issue = getIssue(repo, number);
  return { status: 200, body: issueJson(repo, updateIssue(repo, issue, obj(req.body)), req.base) };
});
on('GET', `${R}/issues/{number}/comments`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const number = intParam(n);
  const target = repo.issues.get(number) ?? repo.pulls.get(number);
  if (target === undefined) throw new ApiError(404, 'Not Found');
  return pageOf(req, target.comments.map((comment) => commentJson(repo, number, comment, req.base)));
});
on('POST', `${R}/issues/{number}/comments`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const number = intParam(n);
  return { status: 201, body: commentJson(repo, number, addComment(repo, number, obj(req.body).body), req.base) };
});
on('GET', `${R}/issues/{number}/labels`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const issue = getIssue(repo, intParam(n));
  return { status: 200, body: issue.labels.map((name) => labelJson(repo, labelOf(repo, name), req.base)) };
});
on('POST', `${R}/issues/{number}/labels`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const issue = getIssue(repo, intParam(n));
  const body = req.body;
  const names = Array.isArray(body) ? body : Array.isArray(obj(body).labels) ? (obj(body).labels as unknown[]) : [];
  updateIssue(repo, issue, { labels: [...issue.labels, ...names] });
  return { status: 200, body: issue.labels.map((name) => labelJson(repo, labelOf(repo, name), req.base)) };
});

function pullAsIssue(repo: Repo, pull: Pull, base: string): Json {
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: userJson(base),
    comments: pull.comments.length,
    created_at: isoOf(pull.created),
    updated_at: isoOf(pull.updated),
    closed_at: pull.closed === null ? null : isoOf(pull.closed),
    pull_request: { url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`, merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt) },
  };
}

// pull requests
on('GET', `${R}/pulls`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  const list = queryPulls(repo, {
    state: req.query.get('state') ?? 'open',
    head: req.query.get('head') ?? undefined,
    base: req.query.get('base') ?? undefined,
    sort: req.query.get('sort') ?? 'created',
    direction: req.query.get('direction') ?? 'desc',
  });
  return pageOf(req, list.map((pull) => pullJson(repo, pull, req.base, false)));
});
on('POST', `${R}/pulls`, (req, [o, r]) => {
  const repo = getRepo(o, r);
  return { status: 201, body: pullJson(repo, createPull(repo, obj(req.body)), req.base) };
});
on('GET', `${R}/pulls/{number}`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  return { status: 200, body: pullJson(repo, getPull(repo, intParam(n)), req.base) };
});
on('PATCH', `${R}/pulls/{number}`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  return { status: 200, body: pullJson(repo, updatePull(repo, getPull(repo, intParam(n)), obj(req.body)), req.base) };
});
on('GET', `${R}/pulls/{number}/files`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const pull = getPull(repo, intParam(n));
  const api = `${req.base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const head = pullHeadSha(repo, pull);
  return pageOf(req, pullFiles(repo, pull).map((file) => ({ ...file, blob_url: `${req.base}/${repo.owner}/${repo.name}/blob/${head}/${file.filename}`, raw_url: `${req.base}/${repo.owner}/${repo.name}/raw/${head}/${file.filename}`, contents_url: `${api}/contents/${file.filename}?ref=${head}` })));
});
on('GET', `${R}/pulls/{number}/commits`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const pull = getPull(repo, intParam(n));
  return pageOf(req, pullCommits(repo, pull).map((sha) => commitJson(repo, sha, req.base)));
});
on('GET', `${R}/pulls/{number}/merge`, (_req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const pull = getPull(repo, intParam(n));
  if (!pull.merged) throw new ApiError(404, 'Not Found');
  return { status: 204, body: null };
});
on('PUT', `${R}/pulls/{number}/merge`, (req, [o, r, n]) => {
  const repo = getRepo(o, r);
  const pull = getPull(repo, intParam(n));
  const result = mergePull(repo, pull, obj(req.body));
  return { status: 200, body: { sha: result.sha, merged: true, message: result.message } };
});
on('GET', `${R}/pulls/{number}/comments`, () => ({ status: 200, body: [] }));
on('GET', `${R}/pulls/{number}/reviews`, () => ({ status: 200, body: [] }));

/** Dispatch one REST request (the path is relative to /api/v3). */
export function route(req: RestRequest): RestAnswer {
  const found = lookup(trie, req.path.split('/').filter(Boolean), 0, []);
  if (found !== null) {
    const handler = found.handlers.get(req.method) ?? (req.method === 'HEAD' ? found.handlers.get('GET') : undefined);
    if (handler !== undefined) return handler(req, found.params);
    // a known resource with a verb it does not take; a missing repository still reads as 404
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)/.exec(req.path);
    if (repoMatch !== null) getRepo(repoMatch[1], repoMatch[2]);
  }
  return { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } };
}

void flattenTree;
