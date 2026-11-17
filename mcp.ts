// mcp.ts: the Model Context Protocol endpoint at /mcp (streamable HTTP, JSON answers).
//
// Both protocol eras are served: the 2026-07-28 revision (server/discover; every request declares its
// revision in _meta; no session) and the handshake revisions (initialize + notifications/initialized, with an
// Mcp-Session-Id). The tools follow github-mcp-server's names and argument names and act on the same store as
// REST, so what an agent creates here reads back over /api/v3 as the same object.

import { ApiError, VIEWER, addComment, branchSha, commitFiles, createIssue, createPull, createRepo, filesAt, getIssue, getPull, getRepo, history, listRepos, mergePull, pullFiles, queryIssues, queryPulls, setRef, store, updateIssue } from './forge.ts';
import { commentJson, commitJson, issueJson, pullJson, repoJson } from './rest.ts';

export interface McpAnswer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const LATEST = '2026-07-28';
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', title: 'Forge MCP server', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } };

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  run: (args: Args, base: string) => unknown;
}

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'number', description });
const OWNER = str('Repository owner (the login the token names)');
const REPO = str('Repository name');

function need(args: Args, name: string, kind: 'string' | 'number' = 'string'): string | number {
  const value = args[name];
  if (kind === 'number') {
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n)) throw new ToolError(`missing required parameter: ${name}`);
    return n;
  }
  if (typeof value !== 'string' || value === '') throw new ToolError(`missing required parameter: ${name}`);
  return value;
}

function opt(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

class ToolError extends Error {}

function repoOf(args: Args) {
  const full = opt(args, 'full_name');
  if (full !== undefined && full.includes('/') && (args.owner === undefined || args.repo === undefined)) {
    const [owner, repo] = full.split('/', 2);
    return getRepo(owner, repo);
  }
  return getRepo(need(args, 'owner') as string, need(args, 'repo') as string);
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: str('Repository name'), description: str('Repository description'), private: { type: 'boolean', description: 'Whether the repository is private' }, auto_init: { type: 'boolean', description: 'Create an initial commit with a README' } }, required: ['name'] },
    run: (args, base) => repoJson(createRepo({ name: need(args, 'name'), description: args.description, private: args.private === true || args.private === 'true', auto_init: args.auto_init === true || args.autoInit === true }), base),
  },
  {
    name: 'get_repo',
    description: 'Get a repository: its id, name, full name, visibility, description and default branch.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO }, required: ['owner', 'repo'] },
    run: (args, base) => repoJson(repoOf(args), base),
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user.',
    inputSchema: { type: 'object', properties: { page: int('Page number (1-based)'), per_page: int('Results per page (max 100)') }, required: [] },
    run: (args, base) => page(listRepos(), args).map((repo) => repoJson(repo, base)),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, title: str('Issue title'), body: str('Issue body (markdown)'), labels: { type: 'array', items: { type: 'string' }, description: 'Label names; each must exist in the repository' } }, required: ['owner', 'repo', 'title'] },
    run: (args, base) => {
      const repo = repoOf(args);
      return issueJson(repo, createIssue(repo, { title: need(args, 'title'), body: args.body, labels: args.labels }), base);
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, issue_number: int('Issue number') }, required: ['owner', 'repo', 'issue_number'] },
    run: (args, base) => {
      const repo = repoOf(args);
      return issueJson(repo, getIssue(repo, need(args, 'issue_number', 'number') as number), base);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, filtered by state and sorted.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state (default open)' }, labels: { type: 'array', items: { type: 'string' }, description: 'Only issues carrying all these labels' }, sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: 'Sort field' }, direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction' }, page: int('Page number (1-based)'), per_page: int('Results per page (max 100)') }, required: ['owner', 'repo'] },
    run: (args, base) => {
      const repo = repoOf(args);
      const state = opt(args, 'state')?.toLowerCase() ?? 'open';
      const list = queryIssues(repo, { state, sort: opt(args, 'sort'), direction: opt(args, 'direction'), labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined });
      return page(list, args).map((issue) => issueJson(repo, issue, base));
    },
  },
  {
    name: 'update_issue',
    description: 'Update an issue: title, body, state (open or closed) or labels.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, issue_number: int('Issue number'), title: str('New title'), body: str('New body'), state: { type: 'string', enum: ['open', 'closed'], description: 'New state' }, labels: { type: 'array', items: { type: 'string' }, description: 'Replacement label names' } }, required: ['owner', 'repo', 'issue_number'] },
    run: (args, base) => {
      const repo = repoOf(args);
      const issue = getIssue(repo, need(args, 'issue_number', 'number') as number);
      const patch: Args = {};
      for (const key of ['title', 'body', 'state', 'labels']) if (args[key] !== undefined) patch[key] = args[key];
      return issueJson(repo, updateIssue(repo, issue, patch), base);
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, issue_number: int('Issue or pull request number'), body: str('Comment text') }, required: ['owner', 'repo', 'issue_number', 'body'] },
    run: (args, base) => {
      const repo = repoOf(args);
      const number = need(args, 'issue_number', 'number') as number;
      return commentJson(repo, number, addComment(repo, number, need(args, 'body')), base);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, title: str('Pull request title'), body: str('Pull request description'), head: str('The branch holding the changes'), base: str('The branch to merge into'), draft: { type: 'boolean', description: 'Open as a draft' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
    run: (args, base) => {
      const repo = repoOf(args);
      return pullJson(repo, createPull(repo, { title: need(args, 'title'), body: args.body, head: need(args, 'head'), base: need(args, 'base'), draft: args.draft === true }), base);
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by its number.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, pull_number: int('Pull request number') }, required: ['owner', 'repo', 'pull_number'] },
    run: (args, base) => {
      const repo = repoOf(args);
      return pullJson(repo, getPull(repo, need(args, 'pull_number', 'number') as number), base);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'State filter (default open)' }, head: str('Head branch filter'), base: str('Base branch filter'), page: int('Page number (1-based)'), per_page: int('Results per page (max 100)') }, required: ['owner', 'repo'] },
    run: (args, base) => {
      const repo = repoOf(args);
      return page(queryPulls(repo, { state: opt(args, 'state') ?? 'open', head: opt(args, 'head'), base: opt(args, 'base') }), args).map((pull) => pullJson(repo, pull, base, false));
    },
  },
  {
    name: 'get_pull_request_files',
    description: 'List the files a pull request changes, with their status and line counts.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, pull_number: int('Pull request number') }, required: ['owner', 'repo', 'pull_number'] },
    run: (args) => {
      const repo = repoOf(args);
      return pullFiles(repo, getPull(repo, need(args, 'pull_number', 'number') as number));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (merge, squash or rebase).',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, pull_number: int('Pull request number'), merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method (default merge)' }, commit_title: str('Title of the merge commit'), commit_message: str('Body of the merge commit') }, required: ['owner', 'repo', 'pull_number'] },
    run: (args) => {
      const repo = repoOf(args);
      const pull = getPull(repo, need(args, 'pull_number', 'number') as number);
      const result = mergePull(repo, pull, { merge_method: opt(args, 'merge_method') ?? 'merge', commit_title: args.commit_title, commit_message: args.commit_message });
      return { sha: result.sha, merged: true, message: result.message, number: pull.number };
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository with their tip commits.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO }, required: ['owner', 'repo'] },
    run: (args) => {
      const repo = repoOf(args);
      return [...repo.refs.entries()].filter(([ref]) => ref.startsWith('refs/heads/')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false }));
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch from another branch (the default branch when from_branch is omitted).',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, branch: str('Name of the new branch'), from_branch: str('Source branch') }, required: ['owner', 'repo', 'branch'] },
    run: (args) => {
      const repo = repoOf(args);
      const branch = need(args, 'branch') as string;
      const from = opt(args, 'from_branch') ?? repo.defaultBranch;
      const sha = branchSha(repo, from);
      if (sha === null) throw new ApiError(404, `Branch ${from} not found`);
      if (branchSha(repo, branch) !== null) throw new ApiError(422, 'Reference already exists');
      setRef(repo, `refs/heads/${branch}`, sha);
      return { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } };
    },
  },
  {
    name: 'get_file_contents',
    description: 'Get a file (base64 content and sha) or a directory listing at a path and ref.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, path: str('Path in the repository'), ref: str('Branch, tag or commit (default branch when omitted)') }, required: ['owner', 'repo', 'path'] },
    run: (args) => {
      const repo = repoOf(args);
      const path = (opt(args, 'path') ?? '').replace(/^\/+|\/+$/g, '');
      const ref = opt(args, 'ref') ?? opt(args, 'branch') ?? repo.defaultBranch;
      const tip = branchSha(repo, ref) ?? (store.has(ref) ? ref : null);
      if (tip === null) throw new ApiError(404, `No commit found for the ref ${ref}`);
      const flat = filesAt(tip);
      const file = flat.get(path);
      if (file !== undefined) {
        const data = store.get(file.sha)?.data ?? Buffer.alloc(0);
        return { type: 'file', path, sha: file.sha, size: data.length, encoding: 'base64', content: data.toString('base64') };
      }
      const prefix = path === '' ? '' : `${path}/`;
      const names = new Set<string>();
      for (const key of flat.keys()) if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
      if (names.size === 0) throw new ApiError(404, 'Not Found');
      return [...names].sort().map((name) => ({ name, path: `${prefix}${name}`, type: flat.has(`${prefix}${name}`) ? 'file' : 'dir' }));
    },
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update one file on a branch with a commit (content is plain text).',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, path: str('Path in the repository'), content: str('New file content'), message: str('Commit message'), branch: str('Branch (default branch when omitted)'), sha: str('Blob sha of the file being replaced, required for an update') }, required: ['owner', 'repo', 'path', 'content', 'message'] },
    run: (args, base) => {
      const repo = repoOf(args);
      const path = need(args, 'path') as string;
      const branch = opt(args, 'branch') ?? repo.defaultBranch;
      if (branchSha(repo, branch) === null && repo.refs.size > 0) {
        const from = branchSha(repo, repo.defaultBranch);
        if (from !== null) setRef(repo, `refs/heads/${branch}`, from);
      }
      const existing = filesAt(branchSha(repo, branch)).get(path);
      if (existing !== undefined && opt(args, 'sha') !== undefined && opt(args, 'sha') !== existing.sha) throw new ApiError(409, `${path} does not match ${String(args.sha)}`);
      const commit = commitFiles(repo, branch, new Map([[path, Buffer.from(String(args.content), 'utf8')]]), need(args, 'message') as string);
      return { content: { path, sha: filesAt(commit).get(path)?.sha }, commit: commitJson(repo, commit, base) };
    },
  },
  {
    name: 'list_commits',
    description: 'List the commits of a branch, newest first.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, sha: str('Branch or commit to start from (default branch when omitted)'), per_page: int('Results per page (max 100)') }, required: ['owner', 'repo'] },
    run: (args, base) => {
      const repo = repoOf(args);
      const tip = branchSha(repo, opt(args, 'sha') ?? repo.defaultBranch) ?? (opt(args, 'sha') !== undefined && store.has(opt(args, 'sha') as string) ? (opt(args, 'sha') as string) : null);
      if (tip === null) return [];
      const per = typeof args.per_page === 'number' ? Math.min(100, Math.max(1, args.per_page)) : 30;
      return history(tip, per).map((sha) => commitJson(repo, sha, base));
    },
  },
  {
    name: 'get_me',
    description: 'Get the authenticated user (the login every repository here belongs to).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => ({ login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, type: 'User' }),
  },
];

function page<T>(list: T[], args: Args): T[] {
  const per = typeof args.per_page === 'number' ? Math.max(1, Math.min(100, args.per_page)) : 30;
  const at = typeof args.page === 'number' ? Math.max(1, args.page) : 1;
  return list.slice((at - 1) * per, at * per);
}

/** The tools/list answer, built once so two calls are byte-identical. */
const TOOL_LIST = TOOLS.map((tool) => ({ name: tool.name, title: tool.name.replace(/_/g, ' '), description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: /^(get|list)_/.test(tool.name) } }));

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function callTool(params: Args, base: string, id: unknown): Record<string, unknown> {
  const name = params.name;
  if (typeof name !== 'string' || name === '') return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
  const tool = TOOLS.find((each) => each.name === name) ?? TOOLS.find((each) => name.toLowerCase().endsWith(each.name));
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'Invalid params: arguments must be an object');
  const missing = tool.inputSchema.required.filter((key) => {
    const value = (args as Args)[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0 && !(missing.every((key) => key === 'owner' || key === 'repo') && typeof (args as Args).full_name === 'string')) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` }], isError: true } };
  }
  try {
    const value = tool.run(args as Args, base);
    const text = JSON.stringify(value);
    const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError: false };
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value;
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    const message = err instanceof ApiError ? `${err.status} ${err.message}` : err instanceof Error ? err.message : String(err);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } };
  }
}

let sessionCounter = 0;

function dispatch(message: unknown, base: string, headers: Record<string, string>): Record<string, unknown> | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, -32600, 'Invalid Request');
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  const isNotification = id === undefined;
  if (typeof method !== 'string') return isNotification ? null : rpcError(id, -32600, 'Invalid Request: method must be a string');
  const p = (params !== null && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Args;
  if (method.startsWith('notifications/')) return null;
  let result: unknown;
  switch (method) {
    case 'server/discover':
      result = {
        supportedVersions: SUPPORTED,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge. Tools act on the repositories of the authenticated user.',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      };
      break;
    case 'initialize': {
      const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      const chosen = SUPPORTED.includes(requested) && requested !== LATEST ? requested : '2025-11-25';
      sessionCounter += 1;
      headers['mcp-session-id'] = `forge-session-${sessionCounter}`;
      result = { protocolVersion: chosen, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: 'A GitHub-compatible forge.' };
      break;
    }
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: TOOL_LIST };
      break;
    case 'tools/call':
      if (isNotification) return null;
      return callTool(p, base, id);
    case 'resources/list':
      result = { resources: [] };
      break;
    case 'resources/templates/list':
      result = { resourceTemplates: [] };
      break;
    case 'prompts/list':
      result = { prompts: [] };
      break;
    case 'logging/setLevel':
      result = {};
      break;
    case 'completion/complete':
      result = { completion: { values: [], hasMore: false } };
      break;
    default:
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
  }
  return isNotification ? null : { jsonrpc: '2.0', id, result };
}

export function handleMcp(method: string, body: Buffer, base: string): McpAnswer {
  if (method === 'DELETE') return { status: 204, headers: {}, body: null };
  if (method === 'GET') return { status: 405, headers: { allow: 'POST, DELETE' }, body: rpcError(null, -32000, 'Method Not Allowed: this server streams no notifications; POST requests') };
  if (method !== 'POST') return { status: 405, headers: { allow: 'POST, DELETE' }, body: rpcError(null, -32000, 'Method Not Allowed') };
  let message: unknown;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, headers: {}, body: rpcError(null, -32700, 'Parse error: the body is not valid JSON') };
  }
  const headers: Record<string, string> = {};
  if (Array.isArray(message)) {
    if (message.length === 0) return { status: 400, headers, body: rpcError(null, -32600, 'Invalid Request: empty batch') };
    const answers = message.map((each) => dispatch(each, base, headers)).filter((each) => each !== null);
    if (answers.length === 0) return { status: 202, headers, body: null };
    return { status: 200, headers, body: answers };
  }
  const answer = dispatch(message, base, headers);
  if (answer === null) return { status: 202, headers, body: null };
  return { status: 200, headers, body: answer };
}
