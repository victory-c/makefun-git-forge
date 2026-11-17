// graphql.ts: GitHub GraphQL v4 at /api/graphql.
//
// A small, complete GraphQL engine: the schema is written below in SDL and parsed once; documents are parsed
// (operations, variables, aliases, fragments, inline fragments, @skip/@include), validated against the schema
// (an unknown field is a 200 with an `errors` entry naming it, as GitHub answers), then executed by plain
// resolvers over forge.ts. Introspection (__type, __schema, __typename) reads the same parsed SDL, so what
// gh's feature probes see is exactly what the executor serves. A JSON array body is a batch: one result per
// operation, in order.

import {
  ApiError,
  VIEWER,
  addComment,
  branchSha,
  commentByDbId,
  createIssue,
  createPull,
  createRepo,
  findRepo,
  getIssue,
  isoOf,
  issueByDbId,
  labelOf,
  listRepos,
  mergePull,
  mergeableOf,
  pullBaseSha,
  pullByDbId,
  pullCommits,
  pullFiles,
  pullHeadSha,
  queryIssues,
  queryPulls,
  repoById,
  resolveRef,
  setIssueState,
  setRef,
  store,
  updateIssue,
  updatePull,
  closePull,
  updateRepo,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
} from './forge.ts';
import { decodeNodeId, nodeId } from './rest.ts';

// =========================================================================================== the schema

const SDL = `
scalar ID
scalar String
scalar Int
scalar Float
scalar Boolean
scalar DateTime
scalar URI
scalar GitObjectID
scalar GitTimestamp
scalar HTML

interface Node { id: ID! }
interface Actor { login: String! avatarUrl(size: Int): URI! url: URI! }
interface Comment { id: ID! body: String! author: Actor createdAt: DateTime! }
interface UniformResourceLocatable { url: URI! }
interface RepositoryOwner { id: ID! login: String! url: URI! }

type Query {
  viewer: User!
  repository(owner: String!, name: String!, followRenames: Boolean = true): Repository
  node(id: ID!): Node
  nodes(ids: [ID!]!): [Node]!
  user(login: String!): User
  repositoryOwner(login: String!): RepositoryOwner
  search(query: String!, type: SearchType!, first: Int, after: String, last: Int, before: String): SearchResultItemConnection!
  rateLimit(dryRun: Boolean = false): RateLimit
}

type Mutation {
  createIssue(input: CreateIssueInput!): CreateIssuePayload
  closeIssue(input: CloseIssueInput!): CloseIssuePayload
  reopenIssue(input: ReopenIssueInput!): ReopenIssuePayload
  updateIssue(input: UpdateIssueInput!): UpdateIssuePayload
  addComment(input: AddCommentInput!): AddCommentPayload
  createPullRequest(input: CreatePullRequestInput!): CreatePullRequestPayload
  mergePullRequest(input: MergePullRequestInput!): MergePullRequestPayload
  closePullRequest(input: ClosePullRequestInput!): ClosePullRequestPayload
  updatePullRequest(input: UpdatePullRequestInput!): UpdatePullRequestPayload
  createRepository(input: CreateRepositoryInput!): CreateRepositoryPayload
  updateRepository(input: UpdateRepositoryInput!): UpdateRepositoryPayload
  createRef(input: CreateRefInput!): CreateRefPayload
  addLabelsToLabelable(input: AddLabelsToLabelableInput!): AddLabelsToLabelablePayload
}

type RateLimit { cost: Int! limit: Int! remaining: Int! resetAt: DateTime! used: Int! nodeCount: Int! }

type User implements Node & Actor & RepositoryOwner {
  id: ID!
  databaseId: Int
  login: String!
  name: String
  email: String!
  avatarUrl(size: Int): URI!
  url: URI!
  bio: String
  company: String
  createdAt: DateTime!
  isViewer: Boolean!
  repository(name: String!): Repository
  repositories(first: Int, after: String, last: Int, before: String, privacy: RepositoryPrivacy, orderBy: RepositoryOrder, ownerAffiliations: [RepositoryAffiliation]): RepositoryConnection!
}

type Repository implements Node & UniformResourceLocatable {
  id: ID!
  databaseId: Int
  name: String!
  nameWithOwner: String!
  owner: RepositoryOwner!
  description: String
  url: URI!
  sshUrl: String!
  homepageUrl: URI
  isPrivate: Boolean!
  visibility: RepositoryVisibility!
  isArchived: Boolean!
  isFork: Boolean!
  isTemplate: Boolean!
  isEmpty: Boolean!
  isDisabled: Boolean!
  isLocked: Boolean!
  isMirror: Boolean!
  hasIssuesEnabled: Boolean!
  hasWikiEnabled: Boolean!
  hasProjectsEnabled: Boolean!
  hasDiscussionsEnabled: Boolean!
  mergeCommitAllowed: Boolean!
  squashMergeAllowed: Boolean!
  rebaseMergeAllowed: Boolean!
  deleteBranchOnMerge: Boolean!
  viewerPermission: RepositoryPermission
  viewerCanAdminister: Boolean!
  viewerHasStarred: Boolean!
  stargazerCount: Int!
  forkCount: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
  pushedAt: DateTime
  defaultBranchRef: Ref
  parent: Repository
  primaryLanguage: Language
  issue(number: Int!): Issue
  issues(first: Int, after: String, last: Int, before: String, states: [IssueState!], orderBy: IssueOrder, labels: [String!], filterBy: IssueFilters): IssueConnection!
  issueOrPullRequest(number: Int!): IssueOrPullRequest
  pullRequest(number: Int!): PullRequest
  pullRequests(first: Int, after: String, last: Int, before: String, states: [PullRequestState!], orderBy: IssueOrder, headRefName: String, baseRefName: String, labels: [String!]): PullRequestConnection!
  label(name: String!): Label
  labels(first: Int, after: String, last: Int, before: String, query: String): LabelConnection
  ref(qualifiedName: String!): Ref
  refs(refPrefix: String!, first: Int, after: String, last: Int, before: String, query: String): RefConnection
  object(oid: GitObjectID, expression: String): GitObject
}

type Language { name: String! color: String }

type Ref implements Node {
  id: ID!
  name: String!
  prefix: String!
  target: GitObject
  repository: Repository!
}

interface GitObject { id: ID! oid: GitObjectID! abbreviatedOid: String! }

type Commit implements Node & GitObject {
  id: ID!
  oid: GitObjectID!
  abbreviatedOid: String!
  message: String!
  messageHeadline: String!
  messageBody: String!
  committedDate: DateTime!
  authoredDate: DateTime!
  author: GitActor
  committer: GitActor
  tree: Tree!
  parents(first: Int, after: String): CommitConnection!
  history(first: Int, after: String): CommitHistoryConnection!
  url: URI!
}

type Tree implements Node & GitObject { id: ID! oid: GitObjectID! abbreviatedOid: String! entries: [TreeEntry!] }
type TreeEntry { name: String! path: String mode: Int! type: String! oid: GitObjectID! }
type Blob implements Node & GitObject { id: ID! oid: GitObjectID! abbreviatedOid: String! text: String byteSize: Int! isBinary: Boolean }
type Tag implements Node & GitObject { id: ID! oid: GitObjectID! abbreviatedOid: String! name: String! message: String target: GitObject! }
type GitActor { name: String email: String date: GitTimestamp user: User }

type Issue implements Node & Comment & UniformResourceLocatable {
  id: ID!
  databaseId: Int
  number: Int!
  title: String!
  body: String!
  bodyText: String!
  state: IssueState!
  stateReason: IssueStateReason
  closed: Boolean!
  closedAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
  url: URI!
  author: Actor
  locked: Boolean!
  repository: Repository!
  labels(first: Int, after: String, last: Int, before: String): LabelConnection
  comments(first: Int, after: String, last: Int, before: String): IssueCommentConnection!
  assignees(first: Int, after: String, last: Int, before: String): UserConnection!
  milestone: Milestone
  reactionGroups: [ReactionGroup!]
  viewerCanUpdate: Boolean!
}

type Milestone { id: ID! title: String! number: Int! }
type ReactionGroup { content: String! }

type PullRequest implements Node & Comment & UniformResourceLocatable {
  id: ID!
  databaseId: Int
  number: Int!
  title: String!
  body: String!
  bodyText: String!
  state: PullRequestState!
  closed: Boolean!
  closedAt: DateTime
  merged: Boolean!
  mergedAt: DateTime
  mergedBy: Actor
  mergeCommit: Commit
  mergeable: MergeableState!
  isDraft: Boolean!
  locked: Boolean!
  createdAt: DateTime!
  updatedAt: DateTime!
  url: URI!
  author: Actor
  headRefName: String!
  headRefOid: GitObjectID!
  headRef: Ref
  headRepository: Repository
  baseRefName: String!
  baseRefOid: GitObjectID!
  baseRef: Ref
  baseRepository: Repository
  repository: Repository!
  isCrossRepository: Boolean!
  additions: Int!
  deletions: Int!
  changedFiles: Int!
  files(first: Int, after: String, last: Int, before: String): PullRequestChangedFileConnection
  commits(first: Int, after: String, last: Int, before: String): PullRequestCommitConnection!
  comments(first: Int, after: String, last: Int, before: String): IssueCommentConnection!
  labels(first: Int, after: String, last: Int, before: String): LabelConnection
  assignees(first: Int, after: String, last: Int, before: String): UserConnection!
  reviewDecision: PullRequestReviewDecision
  viewerCanUpdate: Boolean!
}

type PullRequestChangedFile { path: String! additions: Int! deletions: Int! changeType: PatchStatus! }
type PullRequestCommit implements Node { id: ID! commit: Commit! url: URI! }
type IssueComment implements Node & Comment {
  id: ID!
  databaseId: Int
  body: String!
  bodyText: String!
  author: Actor
  createdAt: DateTime!
  updatedAt: DateTime!
  url: URI!
  issue: Issue!
}
type Label implements Node { id: ID! name: String! color: String! description: String url: URI! }

type PageInfo { hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String endCursor: String }

type IssueConnection { nodes: [Issue] edges: [IssueEdge] pageInfo: PageInfo! totalCount: Int! }
type IssueEdge { node: Issue cursor: String! }
type PullRequestConnection { nodes: [PullRequest] edges: [PullRequestEdge] pageInfo: PageInfo! totalCount: Int! }
type PullRequestEdge { node: PullRequest cursor: String! }
type PullRequestChangedFileConnection { nodes: [PullRequestChangedFile] edges: [PullRequestChangedFileEdge] pageInfo: PageInfo! totalCount: Int! }
type PullRequestChangedFileEdge { node: PullRequestChangedFile cursor: String! }
type PullRequestCommitConnection { nodes: [PullRequestCommit] edges: [PullRequestCommitEdge] pageInfo: PageInfo! totalCount: Int! }
type PullRequestCommitEdge { node: PullRequestCommit cursor: String! }
type IssueCommentConnection { nodes: [IssueComment] edges: [IssueCommentEdge] pageInfo: PageInfo! totalCount: Int! }
type IssueCommentEdge { node: IssueComment cursor: String! }
type LabelConnection { nodes: [Label] edges: [LabelEdge] pageInfo: PageInfo! totalCount: Int! }
type LabelEdge { node: Label cursor: String! }
type UserConnection { nodes: [User] edges: [UserEdge] pageInfo: PageInfo! totalCount: Int! }
type UserEdge { node: User cursor: String! }
type RepositoryConnection { nodes: [Repository] edges: [RepositoryEdge] pageInfo: PageInfo! totalCount: Int! }
type RepositoryEdge { node: Repository cursor: String! }
type RefConnection { nodes: [Ref] edges: [RefEdge] pageInfo: PageInfo! totalCount: Int! }
type RefEdge { node: Ref cursor: String! }
type CommitConnection { nodes: [Commit] edges: [CommitEdge] pageInfo: PageInfo! totalCount: Int! }
type CommitHistoryConnection { nodes: [Commit] edges: [CommitEdge] pageInfo: PageInfo! totalCount: Int! }
type CommitEdge { node: Commit cursor: String! }
type SearchResultItemConnection { nodes: [SearchResultItem] edges: [SearchResultItemEdge] pageInfo: PageInfo! issueCount: Int! repositoryCount: Int! userCount: Int! codeCount: Int! discussionCount: Int! wikiCount: Int! }
type SearchResultItemEdge { node: SearchResultItem cursor: String! }

union SearchResultItem = Issue | PullRequest | Repository | User
union IssueOrPullRequest = Issue | PullRequest

type CreateIssuePayload { clientMutationId: String issue: Issue }
type CloseIssuePayload { clientMutationId: String issue: Issue }
type ReopenIssuePayload { clientMutationId: String issue: Issue }
type UpdateIssuePayload { clientMutationId: String issue: Issue }
type AddCommentPayload { clientMutationId: String commentEdge: IssueCommentEdge subject: Node timelineEdge: IssueCommentEdge }
type CreatePullRequestPayload { clientMutationId: String pullRequest: PullRequest }
type MergePullRequestPayload { clientMutationId: String pullRequest: PullRequest actor: Actor }
type ClosePullRequestPayload { clientMutationId: String pullRequest: PullRequest }
type UpdatePullRequestPayload { clientMutationId: String pullRequest: PullRequest }
type CreateRepositoryPayload { clientMutationId: String repository: Repository }
type UpdateRepositoryPayload { clientMutationId: String repository: Repository }
type CreateRefPayload { clientMutationId: String ref: Ref }
type AddLabelsToLabelablePayload { clientMutationId: String labelable: Issue }

input CreateIssueInput { repositoryId: ID! title: String! body: String assigneeIds: [ID!] labelIds: [ID!] milestoneId: ID projectIds: [ID!] issueTemplate: String clientMutationId: String }
input CloseIssueInput { issueId: ID! stateReason: IssueClosedStateReason clientMutationId: String }
input ReopenIssueInput { issueId: ID! clientMutationId: String }
input UpdateIssueInput { id: ID! title: String body: String state: IssueState labelIds: [ID!] assigneeIds: [ID!] milestoneId: ID clientMutationId: String }
input AddCommentInput { subjectId: ID! body: String! clientMutationId: String }
input CreatePullRequestInput { repositoryId: ID! baseRefName: String! headRefName: String! headRepositoryId: ID title: String! body: String draft: Boolean maintainerCanModify: Boolean clientMutationId: String }
input MergePullRequestInput { pullRequestId: ID! mergeMethod: PullRequestMergeMethod commitHeadline: String commitBody: String expectedHeadOid: GitObjectID authorEmail: String clientMutationId: String }
input ClosePullRequestInput { pullRequestId: ID! clientMutationId: String }
input UpdatePullRequestInput { pullRequestId: ID! title: String body: String baseRefName: String state: PullRequestUpdateState clientMutationId: String }
input CreateRepositoryInput { name: String! ownerId: ID description: String visibility: RepositoryVisibility! homepageUrl: URI hasIssuesEnabled: Boolean hasWikiEnabled: Boolean clientMutationId: String }
input UpdateRepositoryInput { repositoryId: ID! name: String description: String homepageUrl: URI hasIssuesEnabled: Boolean clientMutationId: String }
input CreateRefInput { repositoryId: ID! name: String! oid: GitObjectID! clientMutationId: String }
input AddLabelsToLabelableInput { labelableId: ID! labelIds: [ID!]! clientMutationId: String }
input IssueOrder { field: IssueOrderField! direction: OrderDirection! }
input RepositoryOrder { field: RepositoryOrderField! direction: OrderDirection! }
input IssueFilters { states: [IssueState!] labels: [String!] assignee: String createdBy: String mentioned: String since: DateTime }

enum IssueState { OPEN CLOSED }
enum IssueStateReason { COMPLETED NOT_PLANNED REOPENED DUPLICATE }
enum IssueClosedStateReason { COMPLETED NOT_PLANNED DUPLICATE }
enum PullRequestState { OPEN CLOSED MERGED }
enum PullRequestUpdateState { OPEN CLOSED }
enum PullRequestMergeMethod { MERGE SQUASH REBASE }
enum PullRequestReviewDecision { CHANGES_REQUESTED APPROVED REVIEW_REQUIRED }
enum MergeableState { MERGEABLE CONFLICTING UNKNOWN }
enum PatchStatus { ADDED DELETED RENAMED COPIED MODIFIED CHANGED }
enum RepositoryPermission { ADMIN MAINTAIN WRITE TRIAGE READ }
enum RepositoryVisibility { PRIVATE PUBLIC INTERNAL }
enum RepositoryPrivacy { PUBLIC PRIVATE }
enum RepositoryAffiliation { OWNER COLLABORATOR ORGANIZATION_MEMBER }
enum RepositoryOrderField { CREATED_AT UPDATED_AT PUSHED_AT NAME STARGAZERS }
enum IssueOrderField { CREATED_AT UPDATED_AT COMMENTS }
enum OrderDirection { ASC DESC }
enum SearchType { ISSUE ISSUE_ADVANCED REPOSITORY USER DISCUSSION }

type __Schema { description: String types: [__Type!]! queryType: __Type! mutationType: __Type subscriptionType: __Type directives: [__Directive!]! }
type __Type {
  kind: __TypeKind!
  name: String
  description: String
  specifiedByURL: String
  fields(includeDeprecated: Boolean = false): [__Field!]
  interfaces: [__Type!]
  possibleTypes: [__Type!]
  enumValues(includeDeprecated: Boolean = false): [__EnumValue!]
  inputFields(includeDeprecated: Boolean = false): [__InputValue!]
  ofType: __Type
  isOneOf: Boolean
}
type __Field { name: String! description: String args(includeDeprecated: Boolean = false): [__InputValue!]! type: __Type! isDeprecated: Boolean! deprecationReason: String }
type __InputValue { name: String! description: String type: __Type! defaultValue: String isDeprecated: Boolean! deprecationReason: String }
type __EnumValue { name: String! description: String isDeprecated: Boolean! deprecationReason: String }
type __Directive { name: String! description: String locations: [__DirectiveLocation!]! args(includeDeprecated: Boolean = false): [__InputValue!]! isRepeatable: Boolean! }
enum __TypeKind { SCALAR OBJECT INTERFACE UNION ENUM INPUT_OBJECT LIST NON_NULL }
enum __DirectiveLocation { QUERY MUTATION SUBSCRIPTION FIELD FRAGMENT_DEFINITION FRAGMENT_SPREAD INLINE_FRAGMENT VARIABLE_DEFINITION }
`;

// =========================================================================================== lexing and parsing

interface Token {
  kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
  value: string;
}

class GraphQLError extends Error {
  path?: (string | number)[];
  extra?: Record<string, unknown>;
  constructor(message: string, path?: (string | number)[], extra?: Record<string, unknown>) {
    super(message);
    this.path = path;
    this.extra = extra;
  }
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GraphQLError('Syntax Error: Unterminated string.');
        const raw = source.slice(i + 3, end).replace(/\\"""/g, '"""');
        const lines = raw.split(/\r\n|\n|\r/);
        let common = Infinity;
        for (const line of lines.slice(1)) {
          const indent = line.length - line.trimStart().length;
          if (line.trim() !== '' && indent < common) common = indent;
        }
        const out = lines.map((line, index) => (index === 0 || common === Infinity ? line : line.slice(common)));
        while (out.length > 0 && out[0].trim() === '') out.shift();
        while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
        tokens.push({ kind: 'string', value: out.join('\n') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== '"') {
        if (source[j] === '\\') {
          const e = source[j + 1];
          if (e === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          value += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e;
          j += 2;
          continue;
        }
        if (source[j] === '\n') throw new GraphQLError('Syntax Error: Unterminated string.');
        value += source[j];
        j += 1;
      }
      if (j >= n) throw new GraphQLError('Syntax Error: Unterminated string.');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    throw new GraphQLError(`Syntax Error: Unexpected character ${JSON.stringify(c)}.`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum'; value: unknown }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface Directive {
  name: string;
  args: Map<string, ValueNode>;
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  directives: Directive[];
  selections: Selection[] | null;
}

type Selection =
  | FieldNode
  | { kind: 'spread'; name: string; directives: Directive[] }
  | { kind: 'inline'; typeCondition: string | null; directives: Directive[]; selections: Selection[] };

interface TypeRef {
  kind: 'named' | 'list' | 'nonnull';
  name?: string;
  of?: TypeRef;
}

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: { name: string; type: TypeRef; defaultValue: ValueNode | null }[];
  selections: Selection[];
}

interface Fragment {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.at + offset, this.tokens.length - 1)];
  }

  next(): Token {
    const token = this.tokens[this.at];
    if (this.at < this.tokens.length - 1) this.at += 1;
    return token;
  }

  is(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  expect(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new GraphQLError(`Syntax Error: Expected "${value}", found ${token.kind === 'eof' ? '<EOF>' : JSON.stringify(token.value)}.`);
  }

  name(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLError(`Syntax Error: Expected Name, found ${token.kind === 'eof' ? '<EOF>' : JSON.stringify(token.value)}.`);
    return token.value;
  }

  eof(): boolean {
    return this.peek().kind === 'eof';
  }

  document(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (!this.eof()) {
      if (this.is('{')) {
        operations.push({ type: 'query', name: null, variables: [], selections: this.selectionSet() });
        continue;
      }
      const word = this.name();
      if (word === 'fragment') {
        const name = this.name();
        if (this.name() !== 'on') throw new GraphQLError('Syntax Error: Expected "on".');
        const typeCondition = this.name();
        this.directives();
        fragments.set(name, { name, typeCondition, selections: this.selectionSet() });
        continue;
      }
      if (word !== 'query' && word !== 'mutation' && word !== 'subscription') throw new GraphQLError(`Syntax Error: Unexpected Name "${word}".`);
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.name();
      const variables: Operation['variables'] = [];
      if (this.is('(')) {
        this.next();
        while (!this.is(')')) {
          this.expect('$');
          const varName = this.name();
          this.expect(':');
          const type = this.typeRef();
          let defaultValue: ValueNode | null = null;
          if (this.is('=')) {
            this.next();
            defaultValue = this.value(true);
          }
          this.directives();
          variables.push({ name: varName, type, defaultValue });
        }
        this.next();
      }
      this.directives();
      operations.push({ type: word, name, variables, selections: this.selectionSet() });
    }
    return { operations, fragments };
  }

  typeRef(): TypeRef {
    let ref: TypeRef;
    if (this.is('[')) {
      this.next();
      ref = { kind: 'list', of: this.typeRef() };
      this.expect(']');
    } else ref = { kind: 'named', name: this.name() };
    if (this.is('!')) {
      this.next();
      ref = { kind: 'nonnull', of: ref };
    }
    return ref;
  }

  directives(): Directive[] {
    const out: Directive[] = [];
    while (this.is('@')) {
      this.next();
      const name = this.name();
      out.push({ name, args: this.is('(') ? this.args() : new Map() });
    }
    return out;
  }

  args(): Map<string, ValueNode> {
    const out = new Map<string, ValueNode>();
    this.expect('(');
    while (!this.is(')')) {
      const name = this.name();
      this.expect(':');
      out.set(name, this.value(false));
    }
    this.next();
    return out;
  }

  value(constant: boolean): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct') {
      if (token.value === '$' && !constant) {
        this.next();
        return { kind: 'var', name: this.name() };
      }
      if (token.value === '[') {
        this.next();
        const values: ValueNode[] = [];
        while (!this.is(']')) values.push(this.value(constant));
        this.next();
        return { kind: 'list', values };
      }
      if (token.value === '{') {
        this.next();
        const fields: { name: string; value: ValueNode }[] = [];
        while (!this.is('}')) {
          const name = this.name();
          this.expect(':');
          fields.push({ name, value: this.value(constant) });
        }
        this.next();
        return { kind: 'object', fields };
      }
      throw new GraphQLError(`Syntax Error: Unexpected "${token.value}".`);
    }
    this.next();
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true' || token.value === 'false') return { kind: 'boolean', value: token.value === 'true' };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLError('Syntax Error: Unexpected <EOF>.');
  }

  selectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (!this.is('}')) {
      if (this.eof()) throw new GraphQLError('Syntax Error: Expected Name, found <EOF>.');
      if (this.is('...')) {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value !== 'on') {
          const name = this.name();
          out.push({ kind: 'spread', name, directives: this.directives() });
          continue;
        }
        let typeCondition: string | null = null;
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          typeCondition = this.name();
        }
        const directives = this.directives();
        out.push({ kind: 'inline', typeCondition, directives, selections: this.selectionSet() });
        continue;
      }
      let name = this.name();
      let alias: string | null = null;
      if (this.is(':')) {
        this.next();
        alias = name;
        name = this.name();
      }
      const args = this.is('(') ? this.args() : new Map<string, ValueNode>();
      const directives = this.directives();
      const selections = this.is('{') ? this.selectionSet() : null;
      out.push({ kind: 'field', alias, name, args, directives, selections });
    }
    this.next();
    return out;
  }
}

// =========================================================================================== the parsed schema

interface ArgDef {
  name: string;
  type: TypeRef;
  defaultValue: ValueNode | null;
}

interface FieldDef {
  name: string;
  type: TypeRef;
  args: ArgDef[];
}

interface TypeDef {
  kind: 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT';
  name: string;
  fields: FieldDef[];
  interfaces: string[];
  members: string[];
  values: string[];
}

function parseSdl(source: string): Map<string, TypeDef> {
  const p = new Parser(lex(source));
  const types = new Map<string, TypeDef>();
  const fieldList = (input: boolean): FieldDef[] => {
    const fields: FieldDef[] = [];
    p.expect('{');
    while (!p.is('}')) {
      const name = p.name();
      const args: ArgDef[] = [];
      if (!input && p.is('(')) {
        p.next();
        while (!p.is(')')) {
          const argName = p.name();
          p.expect(':');
          const type = p.typeRef();
          let defaultValue: ValueNode | null = null;
          if (p.is('=')) {
            p.next();
            defaultValue = p.value(true);
          }
          args.push({ name: argName, type, defaultValue });
        }
        p.next();
      }
      p.expect(':');
      fields.push({ name, type: p.typeRef(), args });
    }
    p.next();
    return fields;
  };
  while (!p.eof()) {
    const word = p.name();
    const name = p.name();
    const def: TypeDef = { kind: 'SCALAR', name, fields: [], interfaces: [], members: [], values: [] };
    if (word === 'scalar') def.kind = 'SCALAR';
    else if (word === 'type' || word === 'interface') {
      def.kind = word === 'type' ? 'OBJECT' : 'INTERFACE';
      if (p.peek().kind === 'name' && p.peek().value === 'implements') {
        p.next();
        def.interfaces.push(p.name());
        while (p.is('&')) {
          p.next();
          def.interfaces.push(p.name());
        }
      }
      def.fields = fieldList(false);
    } else if (word === 'input') {
      def.kind = 'INPUT_OBJECT';
      def.fields = fieldList(true);
    } else if (word === 'enum') {
      def.kind = 'ENUM';
      p.expect('{');
      while (!p.is('}')) def.values.push(p.name());
      p.next();
    } else if (word === 'union') {
      def.kind = 'UNION';
      p.expect('=');
      def.members.push(p.name());
      while (p.is('|')) {
        p.next();
        def.members.push(p.name());
      }
    } else throw new Error(`bad SDL keyword ${word}`);
    types.set(name, def);
  }
  return types;
}

const TYPES = parseSdl(SDL);
const QUERY_META: FieldDef[] = [
  { name: '__schema', type: { kind: 'nonnull', of: { kind: 'named', name: '__Schema' } }, args: [] },
  { name: '__type', type: { kind: 'named', name: '__Type' }, args: [{ name: 'name', type: { kind: 'nonnull', of: { kind: 'named', name: 'String' } }, defaultValue: null }] },
];

function namedOf(ref: TypeRef): string {
  return ref.kind === 'named' ? (ref.name as string) : namedOf(ref.of as TypeRef);
}

function fieldDef(typeName: string, field: string): FieldDef | null {
  const type = TYPES.get(typeName);
  if (type === undefined) return null;
  const found = type.fields.find((f) => f.name === field);
  if (found !== undefined) return found;
  if (typeName === 'Query') return QUERY_META.find((f) => f.name === field) ?? null;
  return null;
}

function implementsType(runtime: string, condition: string): boolean {
  if (runtime === condition) return true;
  const cond = TYPES.get(condition);
  if (cond === undefined) return false;
  if (cond.kind === 'UNION') return cond.members.includes(runtime);
  if (cond.kind === 'INTERFACE') return TYPES.get(runtime)?.interfaces.includes(condition) ?? false;
  return false;
}

// =========================================================================================== validation

function validate(selections: Selection[], typeName: string, fragments: Map<string, Fragment>, errors: GraphQLError[], seen = new Set<string>()): void {
  const type = TYPES.get(typeName);
  if (type === undefined) return;
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push(new GraphQLError(`Fragment ${selection.name} was used, but not defined`));
        continue;
      }
      if (seen.has(fragment.name)) continue;
      seen.add(fragment.name);
      if (!TYPES.has(fragment.typeCondition)) errors.push(new GraphQLError(`No such type ${fragment.typeCondition}, so it can't be a fragment condition`));
      else validate(fragment.selections, fragment.typeCondition, fragments, errors, seen);
      continue;
    }
    if (selection.kind === 'inline') {
      const target = selection.typeCondition ?? typeName;
      if (!TYPES.has(target)) errors.push(new GraphQLError(`No such type ${target}, so it can't be a fragment condition`));
      else validate(selection.selections, target, fragments, errors, seen);
      continue;
    }
    if (selection.name === '__typename') continue;
    const def = fieldDef(typeName, selection.name);
    if (def === null) {
      errors.push(new GraphQLError(`Field '${selection.name}' doesn't exist on type '${typeName}'`, undefined, { extensions: { code: 'undefinedField', typeName, fieldName: selection.name } }));
      continue;
    }
    for (const argName of selection.args.keys()) {
      if (!def.args.some((arg) => arg.name === argName)) {
        errors.push(new GraphQLError(`Field '${selection.name}' doesn't accept argument '${argName}'`, undefined, { extensions: { code: 'argumentNotAccepted', name: selection.name, argumentName: argName } }));
      }
    }
    const inner = TYPES.get(namedOf(def.type));
    const leaf = inner === undefined || inner.kind === 'SCALAR' || inner.kind === 'ENUM';
    if (leaf && selection.selections !== null) errors.push(new GraphQLError(`Selections can't be made on scalars (field '${selection.name}' returns ${namedOf(def.type)} but has selections)`));
    else if (!leaf && selection.selections === null) errors.push(new GraphQLError(`Field must have selections (field '${selection.name}' returns ${namedOf(def.type)} but has no selections. Did you mean '${selection.name} { ... }'?)`));
    else if (!leaf && selection.selections !== null) validate(selection.selections, namedOf(def.type), fragments, errors, seen);
  }
}

// =========================================================================================== execution

interface Context {
  base: string;
  variables: Record<string, unknown>;
  fragments: Map<string, Fragment>;
  errors: GraphQLError[];
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
    default:
      return node.value;
  }
}

function argsOf(field: FieldNode, def: FieldDef | null, ctx: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of def?.args ?? []) {
    if (arg.defaultValue !== null) out[arg.name] = valueOf(arg.defaultValue, {});
  }
  for (const [name, node] of field.args) {
    if (node.kind === 'var' && !(node.name in ctx.variables)) continue;
    out[name] = valueOf(node, ctx.variables);
  }
  return out;
}

function included(directives: Directive[], ctx: Context): boolean {
  for (const directive of directives) {
    const value = directive.args.get('if');
    const flag = value === undefined ? true : Boolean(valueOf(value, ctx.variables));
    if (directive.name === 'skip' && flag) return false;
    if (directive.name === 'include' && !flag) return false;
  }
  return true;
}

function collect(selections: Selection[], runtime: string, ctx: Context, out: Map<string, FieldNode[]>, visited = new Set<string>()): Map<string, FieldNode[]> {
  for (const selection of selections) {
    if (!included(selection.directives, ctx)) continue;
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      const list = out.get(key);
      if (list === undefined) out.set(key, [selection]);
      else list.push(selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || implementsType(runtime, selection.typeCondition)) collect(selection.selections, runtime, ctx, out, visited);
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined || visited.has(fragment.name)) continue;
      if (!implementsType(runtime, fragment.typeCondition)) continue;
      visited.add(fragment.name);
      collect(fragment.selections, runtime, ctx, out, visited);
    }
  }
  return out;
}

type Obj = Record<string, unknown> & { __typename: string };

function executeObject(value: Obj, typeName: string, selections: Selection[], ctx: Context, path: (string | number)[]): Record<string, unknown> | null {
  const declared = TYPES.get(typeName);
  const abstract = declared !== undefined && (declared.kind === 'INTERFACE' || declared.kind === 'UNION');
  const runtime = abstract && typeof value.__typename === 'string' && TYPES.has(value.__typename) ? value.__typename : typeName;
  const fields = collect(selections, runtime, ctx, new Map());
  const out: Record<string, unknown> = {};
  for (const [key, nodes] of fields) {
    const node = nodes[0];
    const merged: Selection[] = [];
    for (const each of nodes) if (each.selections !== null) merged.push(...each.selections);
    if (node.name === '__typename') {
      out[key] = runtime;
      continue;
    }
    const def = fieldDef(runtime, node.name);
    const fieldPath = [...path, key];
    try {
      let result: unknown;
      if (runtime === 'Query' && node.name === '__type') {
        const name = String(argsOf(node, def, ctx).name ?? '');
        result = TYPES.has(name) ? typeObject(name) : null;
      } else if (runtime === 'Query' && node.name === '__schema') {
        result = schemaObject();
      } else {
        const raw = value[node.name];
        result = typeof raw === 'function' ? (raw as (args: Record<string, unknown>, ctx: Context) => unknown)(argsOf(node, def, ctx), ctx) : raw;
      }
      out[key] = complete(def?.type ?? { kind: 'named', name: 'String' }, result, merged.length > 0 ? merged : null, ctx, fieldPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const extra: Record<string, unknown> = {};
      if (err instanceof ApiError) extra.type = err.status === 404 ? 'NOT_FOUND' : err.status === 422 ? 'UNPROCESSABLE' : err.status === 405 ? 'UNPROCESSABLE' : 'FORBIDDEN';
      ctx.errors.push(new GraphQLError(message, fieldPath, extra));
      out[key] = null;
    }
  }
  return out;
}

function complete(type: TypeRef, value: unknown, selections: Selection[] | null, ctx: Context, path: (string | number)[]): unknown {
  if (type.kind === 'nonnull') return complete(type.of as TypeRef, value, selections, ctx, path);
  if (value === null || value === undefined) return null;
  if (type.kind === 'list') {
    if (!Array.isArray(value)) return null;
    return value.map((item, index) => complete(type.of as TypeRef, item, selections, ctx, [...path, index]));
  }
  const def = TYPES.get(type.name as string);
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
  if (selections === null) return null;
  return executeObject(value as Obj, def.name, selections, ctx, path);
}

// =========================================================================================== introspection

function typeRefObject(ref: TypeRef): Obj {
  if (ref.kind === 'nonnull') return { __typename: '__Type', kind: 'NON_NULL', name: null, description: null, ofType: typeRefObject(ref.of as TypeRef), fields: null, interfaces: null, possibleTypes: null, enumValues: null, inputFields: null, specifiedByURL: null, isOneOf: null };
  if (ref.kind === 'list') return { __typename: '__Type', kind: 'LIST', name: null, description: null, ofType: typeRefObject(ref.of as TypeRef), fields: null, interfaces: null, possibleTypes: null, enumValues: null, inputFields: null, specifiedByURL: null, isOneOf: null };
  return typeObject(ref.name as string);
}

function inputValue(arg: ArgDef): Obj {
  return {
    __typename: '__InputValue',
    name: arg.name,
    description: null,
    type: () => typeRefObject(arg.type),
    defaultValue: arg.defaultValue === null ? null : JSON.stringify(valueOf(arg.defaultValue, {})),
    isDeprecated: false,
    deprecationReason: null,
  };
}

function typeObject(name: string): Obj {
  const def = TYPES.get(name) as TypeDef;
  const isObjectish = def.kind === 'OBJECT' || def.kind === 'INTERFACE';
  return {
    __typename: '__Type',
    kind: def.kind,
    name: def.name,
    description: null,
    specifiedByURL: null,
    isOneOf: def.kind === 'INPUT_OBJECT' ? false : null,
    fields: () =>
      isObjectish
        ? [...def.fields, ...(name === 'Query' ? [] : [])].map((field) => ({
            __typename: '__Field',
            name: field.name,
            description: null,
            args: () => field.args.map(inputValue),
            type: () => typeRefObject(field.type),
            isDeprecated: false,
            deprecationReason: null,
          }))
        : null,
    interfaces: () => (isObjectish ? def.interfaces.map((iface) => typeObject(iface)) : null),
    possibleTypes: () => {
      if (def.kind === 'UNION') return def.members.map((member) => typeObject(member));
      if (def.kind === 'INTERFACE') return [...TYPES.values()].filter((t) => t.interfaces.includes(name)).map((t) => typeObject(t.name));
      return null;
    },
    enumValues: () => (def.kind === 'ENUM' ? def.values.map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null })) : null),
    inputFields: () => (def.kind === 'INPUT_OBJECT' ? def.fields.map((field) => inputValue({ name: field.name, type: field.type, defaultValue: null })) : null),
    ofType: null,
  };
}

function schemaObject(): Obj {
  return {
    __typename: '__Schema',
    description: 'A GitHub-compatible forge',
    types: () => [...TYPES.keys()].map((name) => typeObject(name)),
    queryType: () => typeObject('Query'),
    mutationType: () => typeObject('Mutation'),
    subscriptionType: null,
    directives: () =>
      ['skip', 'include'].map((name) => ({
        __typename: '__Directive',
        name,
        description: null,
        locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'],
        args: () => [inputValue({ name: 'if', type: { kind: 'nonnull', of: { kind: 'named', name: 'Boolean' } }, defaultValue: null })],
        isRepeatable: false,
      })),
  };
}

// =========================================================================================== the domain graph

type Args = Record<string, unknown>;

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:v2:${index}`).toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^cursor:v2:(\d+)$/.exec(text);
  return match === null ? null : Number(match[1]);
}

/** A Relay connection over `items`, honouring first/last/after/before. */
function connection<T>(items: T[], args: Args, toNode: (item: T) => unknown, extra: Record<string, unknown> = {}): Obj {
  let start = 0;
  let end = items.length;
  const after = decodeCursor(args.after);
  const before = decodeCursor(args.before);
  if (after !== null) start = Math.max(start, after + 1);
  if (before !== null) end = Math.min(end, before);
  if (typeof args.first === 'number') {
    if (args.first < 0) throw new GraphQLError('`first` must be a non-negative integer');
    end = Math.min(end, start + args.first);
  }
  if (typeof args.last === 'number') {
    if (args.last < 0) throw new GraphQLError('`last` must be a non-negative integer');
    start = Math.max(start, end - args.last);
  }
  start = Math.min(start, items.length);
  end = Math.max(start, Math.min(end, items.length));
  const slice = items.slice(start, end);
  const nodes = slice.map(toNode);
  const edges = nodes.map((node, index) => ({ __typename: 'Edge', node, cursor: encodeCursor(start + index) }));
  return {
    __typename: 'Connection',
    nodes,
    edges,
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(start) : null,
      endCursor: slice.length > 0 ? encodeCursor(end - 1) : null,
    },
    ...extra,
  };
}

function userNode(base: string): Obj {
  return {
    __typename: 'User',
    id: nodeId('User', VIEWER.id),
    databaseId: VIEWER.id,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
    avatarUrl: `${base}/avatars/${VIEWER.login}`,
    url: `${base}/${VIEWER.login}`,
    bio: null,
    company: null,
    createdAt: isoOf(1735689600),
    isViewer: true,
    repository: (args: Args) => {
      const repo = findRepo(VIEWER.login, String(args.name ?? ''));
      return repo === null ? null : repoNode(repo, base);
    },
    repositories: (args: Args) => {
      let list = listRepos();
      if (args.privacy === 'PUBLIC') list = list.filter((repo) => !repo.private);
      if (args.privacy === 'PRIVATE') list = list.filter((repo) => repo.private);
      const order = args.orderBy as { field?: string; direction?: string } | undefined;
      if (order?.field === 'NAME') list.sort((a, b) => a.name.localeCompare(b.name));
      if (order?.direction === 'DESC') list.reverse();
      return connection(list, args, (repo) => repoNode(repo, base));
    },
  };
}

function refNode(repo: Repo, qualified: string, base: string): Obj | null {
  const sha = repo.refs.get(qualified);
  if (sha === undefined) return null;
  const slash = qualified.startsWith('refs/heads/') ? 11 : qualified.startsWith('refs/tags/') ? 10 : qualified.lastIndexOf('/') + 1;
  return {
    __typename: 'Ref',
    id: `REF_${Buffer.from(`${repo.id}:${qualified}`).toString('base64url')}`,
    name: qualified.slice(slash),
    prefix: qualified.slice(0, slash),
    target: () => gitObjectNode(repo, sha, base),
    repository: () => repoNode(repo, base),
  };
}

function gitObjectNode(repo: Repo, sha: string, base: string): Obj | null {
  const obj = store.get(sha);
  if (obj === undefined) return null;
  const common = { id: `O_${Buffer.from(sha, 'hex').toString('base64url')}`, oid: sha, abbreviatedOid: sha.slice(0, 7) };
  if (obj.type === 'commit') return commitNode(repo, sha, base);
  if (obj.type === 'tree') return { __typename: 'Tree', ...common, entries: () => (store.tree(sha) ?? []).map((e) => ({ __typename: 'TreeEntry', name: e.name, path: e.name, mode: parseInt(e.mode, 8), type: e.mode === '40000' ? 'tree' : 'blob', oid: e.sha })) };
  if (obj.type === 'blob') return { __typename: 'Blob', ...common, text: obj.data.toString('utf8'), byteSize: obj.data.length, isBinary: obj.data.includes(0) };
  const text = obj.data.toString('utf8');
  return { __typename: 'Tag', ...common, name: /^tag (.*)$/m.exec(text)?.[1] ?? '', message: text.slice(text.indexOf('\n\n') + 2), target: () => gitObjectNode(repo, store.peel(sha), base) };
}

function commitNode(repo: Repo, sha: string, base: string): Obj | null {
  const info = store.commit(sha);
  if (info === null) return null;
  const message = info.message.replace(/\n+$/, '');
  const nl = message.indexOf('\n');
  const actor = (sig: { name: string; email: string; time: number }) => ({ __typename: 'GitActor', name: sig.name, email: sig.email, date: isoOf(sig.time), user: sig.email === VIEWER.email ? userNode(base) : null });
  return {
    __typename: 'Commit',
    id: `C_${Buffer.from(sha, 'hex').toString('base64url')}`,
    oid: sha,
    abbreviatedOid: sha.slice(0, 7),
    message,
    messageHeadline: nl < 0 ? message : message.slice(0, nl),
    messageBody: nl < 0 ? '' : message.slice(nl + 1).replace(/^\n+/, ''),
    committedDate: isoOf(info.committer.time),
    authoredDate: isoOf(info.author.time),
    author: actor(info.author),
    committer: actor(info.committer),
    tree: () => gitObjectNode(repo, info.tree, base),
    parents: (args: Args) => connection(info.parents, args, (parent) => commitNode(repo, parent, base)),
    history: (args: Args) => {
      const list: string[] = [];
      const seen = new Set<string>();
      const queue = [sha];
      while (queue.length > 0 && list.length < 500) {
        const next = queue.shift() as string;
        if (seen.has(next)) continue;
        seen.add(next);
        list.push(next);
        queue.push(...(store.commit(next)?.parents ?? []));
      }
      return connection(list, args, (each) => commitNode(repo, each, base));
    },
    url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

function labelNode(repo: Repo, name: string, base: string): Obj {
  const label = labelOf(repo, name);
  return { __typename: 'Label', id: nodeId('Label', label.id), name: label.name, color: label.color, description: label.description, url: `${base}/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}` };
}

function commentNode(repo: Repo, number: number, comment: Comment, base: string): Obj {
  return {
    __typename: 'IssueComment',
    id: nodeId('IssueComment', comment.id),
    databaseId: comment.id,
    body: comment.body,
    bodyText: comment.body,
    author: () => userNode(base),
    createdAt: isoOf(comment.created),
    updatedAt: isoOf(comment.updated),
    url: `${base}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    issue: () => {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueNode(repo, issue, base);
    },
  };
}

function issueNode(repo: Repo, issue: Issue, base: string): Obj {
  return {
    __typename: 'Issue',
    id: nodeId('Issue', issue.id),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    bodyText: issue.body ?? '',
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    stateReason: issue.stateReason === null ? null : issue.stateReason.toUpperCase().replace(/ /g, '_'),
    closed: issue.state === 'closed',
    closedAt: issue.closed === null ? null : isoOf(issue.closed),
    createdAt: isoOf(issue.created),
    updatedAt: isoOf(issue.updated),
    url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: () => userNode(base),
    locked: false,
    repository: () => repoNode(repo, base),
    labels: (args: Args) => connection(issue.labels, args, (name) => labelNode(repo, name, base)),
    comments: (args: Args) => connection(issue.comments, args, (comment) => commentNode(repo, issue.number, comment, base)),
    assignees: (args: Args) => connection([], args, () => null),
    milestone: null,
    reactionGroups: [],
    viewerCanUpdate: true,
  };
}

function pullNode(repo: Repo, pull: Pull, base: string): Obj {
  const files = () => pullFiles(repo, pull);
  return {
    __typename: 'PullRequest',
    id: nodeId('PullRequest', pull.id),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    bodyText: pull.body ?? '',
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    closed: pull.state === 'closed',
    closedAt: pull.closed === null ? null : isoOf(pull.closed),
    merged: pull.merged,
    mergedAt: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    mergedBy: () => (pull.merged ? userNode(base) : null),
    mergeCommit: () => (pull.mergeSha === null ? null : commitNode(repo, pull.mergeSha, base)),
    mergeable: () => mergeableOf(repo, pull),
    isDraft: pull.draft,
    locked: false,
    createdAt: isoOf(pull.created),
    updatedAt: isoOf(pull.updated),
    url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author: () => userNode(base),
    headRefName: pull.head,
    headRefOid: () => pullHeadSha(repo, pull),
    headRef: () => refNode(repo, `refs/heads/${pull.head}`, base),
    headRepository: () => repoNode(repo, base),
    baseRefName: pull.base,
    baseRefOid: () => pullBaseSha(repo, pull),
    baseRef: () => refNode(repo, `refs/heads/${pull.base}`, base),
    baseRepository: () => repoNode(repo, base),
    repository: () => repoNode(repo, base),
    isCrossRepository: false,
    additions: () => files().reduce((sum, file) => sum + file.additions, 0),
    deletions: () => files().reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: () => files().length,
    files: (args: Args) =>
      connection(files(), args, (file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      })),
    commits: (args: Args) =>
      connection(pullCommits(repo, pull), args, (sha) => ({
        __typename: 'PullRequestCommit',
        id: `PRC_${Buffer.from(`${pull.id}:${sha}`).toString('base64url')}`,
        commit: () => commitNode(repo, sha, base),
        url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}/commits/${sha}`,
      })),
    comments: (args: Args) => connection(pull.comments, args, (comment) => commentNode(repo, pull.number, comment, base)),
    labels: (args: Args) => connection([], args, () => null),
    assignees: (args: Args) => connection([], args, () => null),
    reviewDecision: null,
    viewerCanUpdate: true,
  };
}

function enumList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function repoNode(repo: Repo, base: string): Obj {
  return {
    __typename: 'Repository',
    id: nodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: () => userNode(base),
    description: repo.description,
    url: `${base}/${repo.owner}/${repo.name}`,
    sshUrl: `git@forge:${repo.owner}/${repo.name}.git`,
    homepageUrl: repo.homepage,
    isPrivate: repo.private,
    visibility: repo.private ? 'PRIVATE' : 'PUBLIC',
    isArchived: false,
    isFork: false,
    isTemplate: false,
    isEmpty: repo.refs.size === 0,
    isDisabled: false,
    isLocked: false,
    isMirror: false,
    hasIssuesEnabled: repo.hasIssues,
    hasWikiEnabled: false,
    hasProjectsEnabled: false,
    hasDiscussionsEnabled: false,
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    deleteBranchOnMerge: false,
    viewerPermission: 'ADMIN',
    viewerCanAdminister: true,
    viewerHasStarred: false,
    stargazerCount: 0,
    forkCount: 0,
    createdAt: isoOf(repo.created),
    updatedAt: isoOf(repo.updated),
    pushedAt: repo.pushed === null ? null : isoOf(repo.pushed),
    defaultBranchRef: () => refNode(repo, `refs/heads/${repo.defaultBranch}`, base),
    parent: null,
    primaryLanguage: null,
    issue: (args: Args) => {
      const issue = repo.issues.get(Number(args.number));
      if (issue === undefined) {
        if (repo.pulls.has(Number(args.number))) return null;
        throw new GraphQLError(`Could not resolve to an Issue with the number of ${String(args.number)}.`, undefined, { type: 'NOT_FOUND' });
      }
      return issueNode(repo, issue, base);
    },
    issueOrPullRequest: (args: Args) => {
      const number = Number(args.number);
      const issue = repo.issues.get(number);
      if (issue !== undefined) return issueNode(repo, issue, base);
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullNode(repo, pull, base);
    },
    issues: (args: Args) => {
      const filter = (args.filterBy ?? {}) as Args;
      const states = enumList(args.states) ?? enumList(filter.states);
      const order = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const field = order?.field === 'UPDATED_AT' ? 'updated' : order?.field === 'COMMENTS' ? 'comments' : 'created';
      const direction = order?.direction === 'DESC' ? 'desc' : 'asc';
      let list = queryIssues(repo, { state: 'all', sort: field, direction, labels: (enumList(args.labels) ?? enumList(filter.labels)) ?? undefined });
      if (states !== null) list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      return connection(list, args, (issue) => issueNode(repo, issue, base));
    },
    pullRequest: (args: Args) => {
      const pull = repo.pulls.get(Number(args.number));
      if (pull === undefined) throw new GraphQLError(`Could not resolve to a PullRequest with the number of ${String(args.number)}.`, undefined, { type: 'NOT_FOUND' });
      return pullNode(repo, pull, base);
    },
    pullRequests: (args: Args) => {
      const states = enumList(args.states);
      const order = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      let list = queryPulls(repo, {
        state: 'all',
        head: typeof args.headRefName === 'string' ? args.headRefName : undefined,
        base: typeof args.baseRefName === 'string' ? args.baseRefName : undefined,
        sort: order?.field === 'UPDATED_AT' ? 'updated' : 'created',
        direction: order?.direction === 'DESC' ? 'desc' : 'asc',
      });
      if (states !== null) list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
      return connection(list, args, (pull) => pullNode(repo, pull, base));
    },
    label: (args: Args) => {
      const label = repo.labels.get(String(args.name ?? '').toLowerCase());
      return label === undefined ? null : labelNode(repo, label.name, base);
    },
    labels: (args: Args) => {
      let list = [...repo.labels.values()].map((label) => label.name);
      if (typeof args.query === 'string' && args.query !== '') list = list.filter((name) => name.toLowerCase().includes((args.query as string).toLowerCase()));
      return connection(list, args, (name) => labelNode(repo, name, base));
    },
    ref: (args: Args) => {
      const name = String(args.qualifiedName ?? '');
      return refNode(repo, name.startsWith('refs/') ? name : `refs/heads/${name}`, base) ?? refNode(repo, `refs/tags/${name}`, base);
    },
    refs: (args: Args) => {
      const prefix = String(args.refPrefix ?? 'refs/heads/');
      let list = [...repo.refs.keys()].filter((ref) => ref.startsWith(prefix)).sort();
      if (typeof args.query === 'string' && args.query !== '') list = list.filter((ref) => ref.includes(args.query as string));
      return connection(list, args, (ref) => refNode(repo, ref, base));
    },
    object: (args: Args) => {
      const target = typeof args.oid === 'string' ? args.oid : typeof args.expression === 'string' ? resolveRef(repo, args.expression.split(':')[0]) : null;
      return target === null ? null : gitObjectNode(repo, target, base);
    },
  };
}

/** Resolve a global id to its node, or null. */
function nodeById(id: unknown, base: string): Obj | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith('REF_')) {
    const text = Buffer.from(id.slice(4), 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    const repo = repoById(Number(text.slice(0, colon)));
    return repo === null ? null : refNode(repo, text.slice(colon + 1), base);
  }
  const decoded = decodeNodeId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoById(decoded.id);
    return repo === null ? null : repoNode(repo, base);
  }
  if (decoded.kind === 'Issue') {
    const found = issueByDbId(decoded.id);
    return found === null ? null : issueNode(found.repo, found.issue, base);
  }
  if (decoded.kind === 'PullRequest') {
    const found = pullByDbId(decoded.id);
    return found === null ? null : pullNode(found.repo, found.pull, base);
  }
  if (decoded.kind === 'IssueComment') {
    const found = commentByDbId(decoded.id);
    return found === null ? null : commentNode(found.repo, found.issue, found.comment, base);
  }
  if (decoded.kind === 'User' && decoded.id === VIEWER.id) return userNode(base);
  return null;
}

function requireRepo(id: unknown): Repo {
  const decoded = typeof id === 'string' ? decodeNodeId(id) : null;
  const repo = decoded !== null && decoded.kind === 'Repository' ? repoById(decoded.id) : null;
  if (repo === null) throw new GraphQLError(`Could not resolve to a node with the global id of '${String(id)}'.`, undefined, { type: 'NOT_FOUND' });
  return repo;
}

function requireIssue(id: unknown): { repo: Repo; issue: Issue } {
  const decoded = typeof id === 'string' ? decodeNodeId(id) : null;
  const found = decoded !== null && decoded.kind === 'Issue' ? issueByDbId(decoded.id) : null;
  if (found === null) throw new GraphQLError(`Could not resolve to an Issue with the global id of '${String(id)}'.`, undefined, { type: 'NOT_FOUND' });
  return found;
}

function requirePull(id: unknown): { repo: Repo; pull: Pull } {
  const decoded = typeof id === 'string' ? decodeNodeId(id) : null;
  const found = decoded !== null && decoded.kind === 'PullRequest' ? pullByDbId(decoded.id) : null;
  if (found === null) throw new GraphQLError(`Could not resolve to a PullRequest with the global id of '${String(id)}'.`, undefined, { type: 'NOT_FOUND' });
  return found;
}

function labelNamesFromIds(repo: Repo, ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const names: string[] = [];
  for (const id of ids) {
    const decoded = typeof id === 'string' ? decodeNodeId(id) : null;
    const label = [...repo.labels.values()].find((each) => decoded !== null && each.id === decoded.id);
    if (label === undefined) throw new GraphQLError(`Could not resolve to a Label with the global id of '${String(id)}'.`, undefined, { type: 'NOT_FOUND' });
    names.push(label.name);
  }
  return names;
}

function input(args: Args): Args {
  const value = args.input;
  if (value === null || typeof value !== 'object') throw new GraphQLError("Argument 'input' on Field is required");
  return value as Args;
}

function queryRoot(base: string): Obj {
  return {
    __typename: 'Query',
    viewer: () => userNode(base),
    repository: (args: Args) => {
      const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : repoNode(repo, base);
    },
    node: (args: Args) => nodeById(args.id, base),
    nodes: (args: Args) => (Array.isArray(args.ids) ? args.ids.map((id) => nodeById(id, base)) : []),
    user: (args: Args) => (String(args.login ?? '').toLowerCase() === VIEWER.login.toLowerCase() ? userNode(base) : null),
    repositoryOwner: (args: Args) => (String(args.login ?? '').toLowerCase() === VIEWER.login.toLowerCase() ? userNode(base) : null),
    rateLimit: () => ({ __typename: 'RateLimit', cost: 1, limit: 5000, remaining: 4999, resetAt: isoOf(1767229200), used: 1, nodeCount: 0 }),
    search: (args: Args) => search(args, base),
  };
}

function search(args: Args, base: string): Obj {
  const words = String(args.query ?? '').split(/\s+/).filter(Boolean);
  let repos = listRepos();
  const terms: string[] = [];
  let kind: 'issue' | 'pr' | null = null;
  let state: string | null = null;
  for (const word of words) {
    const colon = word.indexOf(':');
    const key = colon < 0 ? '' : word.slice(0, colon);
    const value = colon < 0 ? word : word.slice(colon + 1);
    if (key === 'repo') repos = repos.filter((repo) => `${repo.owner}/${repo.name}`.toLowerCase() === value.toLowerCase());
    else if (key === 'is' && (value === 'issue' || value === 'pr')) kind = value;
    else if ((key === 'is' || key === 'state') && (value === 'open' || value === 'closed' || value === 'merged')) state = value;
    else if (key === 'type' && (value === 'issue' || value === 'pr')) kind = value;
    else if (key === '' ) terms.push(word.toLowerCase());
  }
  if (args.type === 'REPOSITORY') {
    const list = listRepos().filter((repo) => terms.every((term) => repo.name.toLowerCase().includes(term)));
    return connection(list, args, (repo) => repoNode(repo, base), { issueCount: 0, repositoryCount: list.length, userCount: 0, codeCount: 0, discussionCount: 0, wikiCount: 0 });
  }
  const items: Obj[] = [];
  for (const repo of repos) {
    if (kind !== 'pr') {
      for (const issue of repo.issues.values()) {
        if (state !== null && issue.state !== state) continue;
        if (!terms.every((term) => `${issue.title} ${issue.body ?? ''}`.toLowerCase().includes(term))) continue;
        items.push(issueNode(repo, issue, base));
      }
    }
    if (kind !== 'issue') {
      for (const pull of repo.pulls.values()) {
        const pullState = pull.merged ? 'merged' : pull.state;
        if (state !== null && pullState !== state && !(state === 'closed' && pull.state === 'closed')) continue;
        if (!terms.every((term) => `${pull.title} ${pull.body ?? ''}`.toLowerCase().includes(term))) continue;
        items.push(pullNode(repo, pull, base));
      }
    }
  }
  return connection(items, args, (item) => item, { issueCount: items.length, repositoryCount: 0, userCount: 0, codeCount: 0, discussionCount: 0, wikiCount: 0 });
}

function mutationRoot(base: string): Obj {
  return {
    __typename: 'Mutation',
    createIssue: (args: Args) => {
      const data = input(args);
      const repo = requireRepo(data.repositoryId);
      const labels = labelNamesFromIds(repo, data.labelIds);
      const issue = createIssue(repo, { title: data.title, body: data.body, labels });
      return { __typename: 'CreateIssuePayload', clientMutationId: data.clientMutationId ?? null, issue: issueNode(repo, issue, base) };
    },
    closeIssue: (args: Args) => {
      const data = input(args);
      const { repo, issue } = requireIssue(data.issueId);
      setIssueState(issue, 'closed', typeof data.stateReason === 'string' ? data.stateReason.toLowerCase() : 'completed');
      return { __typename: 'CloseIssuePayload', clientMutationId: data.clientMutationId ?? null, issue: issueNode(repo, issue, base) };
    },
    reopenIssue: (args: Args) => {
      const data = input(args);
      const { repo, issue } = requireIssue(data.issueId);
      setIssueState(issue, 'open');
      return { __typename: 'ReopenIssuePayload', clientMutationId: data.clientMutationId ?? null, issue: issueNode(repo, issue, base) };
    },
    updateIssue: (args: Args) => {
      const data = input(args);
      const { repo, issue } = requireIssue(data.id);
      const patch: Args = {};
      if (typeof data.title === 'string') patch.title = data.title;
      if (typeof data.body === 'string') patch.body = data.body;
      if (data.state === 'OPEN' || data.state === 'CLOSED') patch.state = data.state.toLowerCase();
      const labels = labelNamesFromIds(repo, data.labelIds);
      if (labels !== undefined) patch.labels = labels;
      updateIssue(repo, issue, patch);
      return { __typename: 'UpdateIssuePayload', clientMutationId: data.clientMutationId ?? null, issue: issueNode(repo, issue, base) };
    },
    addComment: (args: Args) => {
      const data = input(args);
      const decoded = typeof data.subjectId === 'string' ? decodeNodeId(data.subjectId) : null;
      let target: { repo: Repo; number: number } | null = null;
      if (decoded?.kind === 'Issue') {
        const found = issueByDbId(decoded.id);
        if (found !== null) target = { repo: found.repo, number: found.issue.number };
      } else if (decoded?.kind === 'PullRequest') {
        const found = pullByDbId(decoded.id);
        if (found !== null) target = { repo: found.repo, number: found.pull.number };
      }
      if (target === null) throw new GraphQLError(`Could not resolve to a node with the global id of '${String(data.subjectId)}'.`, undefined, { type: 'NOT_FOUND' });
      const comment = addComment(target.repo, target.number, data.body);
      const node = commentNode(target.repo, target.number, comment, base);
      const edge = { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(0) };
      return { __typename: 'AddCommentPayload', clientMutationId: data.clientMutationId ?? null, commentEdge: edge, timelineEdge: edge, subject: () => nodeById(data.subjectId, base) };
    },
    createPullRequest: (args: Args) => {
      const data = input(args);
      const repo = requireRepo(data.repositoryId);
      const pull = createPull(repo, { title: data.title, body: data.body, head: data.headRefName, base: data.baseRefName, draft: data.draft });
      return { __typename: 'CreatePullRequestPayload', clientMutationId: data.clientMutationId ?? null, pullRequest: pullNode(repo, pull, base) };
    },
    mergePullRequest: (args: Args) => {
      const data = input(args);
      const { repo, pull } = requirePull(data.pullRequestId);
      const method = typeof data.mergeMethod === 'string' ? data.mergeMethod.toLowerCase() : 'merge';
      mergePull(repo, pull, { merge_method: method, commit_title: data.commitHeadline, commit_message: data.commitBody, sha: data.expectedHeadOid });
      return { __typename: 'MergePullRequestPayload', clientMutationId: data.clientMutationId ?? null, pullRequest: pullNode(repo, pull, base), actor: () => userNode(base) };
    },
    closePullRequest: (args: Args) => {
      const data = input(args);
      const { repo, pull } = requirePull(data.pullRequestId);
      if (pull.state === 'open') closePull(repo, pull);
      return { __typename: 'ClosePullRequestPayload', clientMutationId: data.clientMutationId ?? null, pullRequest: pullNode(repo, pull, base) };
    },
    updatePullRequest: (args: Args) => {
      const data = input(args);
      const { repo, pull } = requirePull(data.pullRequestId);
      const patch: Args = {};
      if (typeof data.title === 'string') patch.title = data.title;
      if (typeof data.body === 'string') patch.body = data.body;
      if (typeof data.baseRefName === 'string') patch.base = data.baseRefName;
      if (data.state === 'OPEN' || data.state === 'CLOSED') patch.state = data.state.toLowerCase();
      updatePull(repo, pull, patch);
      return { __typename: 'UpdatePullRequestPayload', clientMutationId: data.clientMutationId ?? null, pullRequest: pullNode(repo, pull, base) };
    },
    createRepository: (args: Args) => {
      const data = input(args);
      const repo = createRepo({ name: data.name, description: data.description, private: data.visibility !== 'PUBLIC', homepage: data.homepageUrl, has_issues: data.hasIssuesEnabled });
      return { __typename: 'CreateRepositoryPayload', clientMutationId: data.clientMutationId ?? null, repository: repoNode(repo, base) };
    },
    updateRepository: (args: Args) => {
      const data = input(args);
      const repo = requireRepo(data.repositoryId);
      const patch: Args = {};
      for (const [from, to] of [['name', 'name'], ['description', 'description'], ['homepageUrl', 'homepage'], ['hasIssuesEnabled', 'has_issues']]) if (from in data) patch[to] = data[from];
      updateRepo(repo, patch);
      return { __typename: 'UpdateRepositoryPayload', clientMutationId: data.clientMutationId ?? null, repository: repoNode(repo, base) };
    },
    createRef: (args: Args) => {
      const data = input(args);
      const repo = requireRepo(data.repositoryId);
      const name = String(data.name ?? '');
      const oid = String(data.oid ?? '');
      if (!name.startsWith('refs/')) throw new GraphQLError('Reference name must start with refs/', undefined, { type: 'UNPROCESSABLE' });
      if (repo.refs.has(name)) throw new GraphQLError('A ref named that already exists', undefined, { type: 'UNPROCESSABLE' });
      if (!store.has(oid)) throw new GraphQLError('Object does not exist', undefined, { type: 'UNPROCESSABLE' });
      setRef(repo, name, oid);
      return { __typename: 'CreateRefPayload', clientMutationId: data.clientMutationId ?? null, ref: refNode(repo, name, base) };
    },
    addLabelsToLabelable: (args: Args) => {
      const data = input(args);
      const { repo, issue } = requireIssue(data.labelableId);
      const labels = labelNamesFromIds(repo, data.labelIds) ?? [];
      updateIssue(repo, issue, { labels: [...new Set([...issue.labels, ...labels])] });
      return { __typename: 'AddLabelsToLabelablePayload', clientMutationId: data.clientMutationId ?? null, labelable: issueNode(repo, getIssue(repo, issue.number), base) };
    },
  };
}

// =========================================================================================== the endpoint

function errorJson(error: GraphQLError): Record<string, unknown> {
  const out: Record<string, unknown> = { message: error.message };
  if (error.path !== undefined) out.path = error.path;
  if (error.extra !== undefined) Object.assign(out, error.extra);
  out.locations = [];
  return out;
}

function runOne(request: unknown, base: string): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  const { query, variables, operationName } = request as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string' || query.trim() === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let document: { operations: Operation[]; fragments: Map<string, Fragment> };
  try {
    document = new Parser(lex(query)).document();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err), locations: [] }] };
  }
  let operation: Operation | undefined;
  if (typeof operationName === 'string' && operationName !== '') operation = document.operations.find((op) => op.name === operationName);
  else if (document.operations.length === 1) operation = document.operations[0];
  if (operation === undefined) {
    return { errors: [{ message: document.operations.length === 0 ? 'No operations in query document' : typeof operationName === 'string' && operationName !== '' ? `No operation named "${operationName}"` : 'An operation name is required' }] };
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validation: GraphQLError[] = [];
  validate(operation.selections, rootType, document.fragments, validation);
  if (validation.length > 0) return { errors: validation.map(errorJson) };
  const given = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  const resolved: Record<string, unknown> = {};
  for (const variable of operation.variables) {
    if (variable.name in given) resolved[variable.name] = given[variable.name];
    else if (variable.defaultValue !== null) resolved[variable.name] = valueOf(variable.defaultValue, {});
    else if (variable.type.kind === 'nonnull') return { errors: [{ message: `Variable $${variable.name} of type ${typeName(variable.type)} was provided invalid value`, locations: [] }] };
  }
  const ctx: Context = { base, variables: resolved, fragments: document.fragments, errors: [] };
  const root = rootType === 'Mutation' ? mutationRoot(base) : queryRoot(base);
  const data = executeObject(root, rootType, operation.selections, ctx, []);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors.map(errorJson);
  return out;
}

function typeName(ref: TypeRef): string {
  if (ref.kind === 'nonnull') return `${typeName(ref.of as TypeRef)}!`;
  if (ref.kind === 'list') return `[${typeName(ref.of as TypeRef)}]`;
  return ref.name as string;
}

/** One request body: an operation object, or an array of them (a batch). */
export function handleGraphQL(body: unknown, base: string): unknown {
  if (Array.isArray(body)) return body.map((each) => runOne(each, base));
  return runOne(body, base);
}

void branchSha;
