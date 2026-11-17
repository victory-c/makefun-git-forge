# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/victory-c/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/victory-c/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process with no dependencies: git smart HTTP (upload-pack protocol v2 and v0, receive-pack with report-status over side-band-64k, shallow fetches, thin and delta packs), the REST v3 API for repositories, contents, branches, issues, labels, comments and pull requests (with three-way squash/merge/rebase merges), a GraphQL v4 engine with introspection for the documents gh and github-mcp-server send, and an MCP endpoint whose tools act on the same in-memory store.

## Layout

- `main.ts`: the process lifecycle (register with the env, serve, exit when done), auth and dispatch
- `git.ts`: objects, pkt-lines, packfile reading and writing, reachability walks
- `smart.ts`: git smart HTTP (info/refs, ls-refs, fetch, receive-pack)
- `forge.ts`: repositories, refs, commits, issues, pull requests and merges
- `rest.ts`: REST v3 routes and GitHub-shaped JSON
- `graphql.ts`: SDL schema, parser, validator, executor and introspection
- `mcp.ts`: Model Context Protocol (2026-07-28 `server/discover` and the `initialize` handshake)

## Run it

```sh
MAKEFUN_SHOP_TOKEN=secret PORT=8000 node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=dsps50bd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
