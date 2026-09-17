# MCPs performance verification — 2026-09-17

Implementation: `13bf7b5`. Plugin ID remains `mcps`. Only this package was changed.
Live source was confirmed before editing with `bb plugin source mcps --json`:
`path:/home/g4f4r0/projects/bb-plugins/bb-plugin-mcps`.

## Measured before / after

| Check | Before | After |
| --- | --- | --- |
| Cold search, 50 servers × 500 tools | 434.7 ms | 169.5 ms |
| Warm search, same 25,000 tools | 94.6 ms | 11.0 ms |
| Compact list, 50 servers | 1.8 ms, zero connections | 1.9 ms, zero connections |
| 500-tool detail view | 500 DOM rows | 50 rows per page; tool 499 reachable |
| Out-of-order detail responses | Alpha tools overwrite Beta | Late response discarded; old read aborted |
| Failed catalog refresh after five-minute TTL | Old tools, error hidden | Empty tools with error visible |
| Two simultaneous same-name installs | Same ID; one overwritten | Distinct IDs; both preserved |
| Concurrent reconnects while old transport closes | New start before close finishes | One shared reconnect after close |

Gateway measurements use deterministic in-memory servers, SQLite storage, and the
same test against the pre-change gateway from Git and the final implementation.
These are individual local samples, not production latency guarantees. Subsequent
full-suite samples varied: cold search 153–170 ms, warm search 9.6–11.0 ms.
Network/OAuth/process startup latency is not represented in this fixture.

Live official registry search (`github`, 12 results): 620.7 ms first request,
7.1 ms repeat from the new page cache; both returned a next-page cursor.

## Findings and changes

- `app.tsx:584`, `lib/read-rpc.ts:7`: snapshot refreshes abort their previous
  HTTP request and reject stale completions. Realtime out-of-order coverage added.
  The SDK's `useRpc().call()` has no signal argument, so these reads use the
  SDK-documented public HTTP RPC envelope. Mutations retain SDK RPC calls.
- `app.tsx:772`: registry debounce previously cancelled only its timer, leaving
  issued requests free to overwrite newer results. Reads now abort on query/page
  changes and unmount; cursor navigation exposes further marketplace results.
- `app.tsx:934`, `app.tsx:1201`: cancellable inspection and keyed detail mounts
  prevent both late responses and a previous server's tools during route changes.
- `app.tsx:575`: installed servers and tool descriptions render in 50-row pages.
  Filtering still searches the entire installed list.
- `src/gateway.ts:341`, `src/lru.ts:2`: derived catalogs/search text use a 128-server
  LRU; eviction also drops opaque references. The 140-server test checks eviction,
  search completeness, duplicate tool names across servers, and schema lookup.
- `src/gateway.ts:724`: a per-server reverse index replaces a scan of every
  server's tool index on each refresh. Initial connection no longer rebuilds the
  same catalog twice. Raw catalog arrays were shared references, not independent
  deep copies; live connection/pending maps are lifecycle state, not LRU caches.
- `src/gateway.ts:778`: refreshes are single-flight and abort on invalidation.
  Identity tokens fence late work without retaining deleted-server epoch counters.
  Refresh after LRU eviction preserves freshness. The five-minute TTL itself was
  not shortened; failed-refresh masking was the reproduced defect.
- `src/gateway.ts:856`: inspection reports refresh/auth errors rather than silently
  returning stale tools. Disabled/unapproved servers return no tools.
- `src/gateway.ts:924`, `src/catalog.ts:29`: normalize search text at indexing time,
  tokenize the query once, reuse opaque references, and construct rich schemas/
  call cards only for final hits. Search wait timers are cleared when work wins.
- `src/gateway.ts:535`: reconnect bursts share one close-and-connect operation.
  Existing ordinary connection deduplication and five-second failure backoff
  already worked (30 concurrent inspections tested); they were retained.
- `server.ts:330`: reserve install IDs before filesystem awaits, release in finally.
- `server.ts:418`: successful registry pages use a 64-entry, 60-second LRU keyed
  by registry URL, query, limit, filter and cursor. `src/registry.ts:159` adds an
  eight-second HTTP deadline and supports caller cancellation.
- `server.ts:555`, `server.ts:908`: removing a server now resets its cached OAuth
  provider as well as closing its transport. Gateway disposal releases derived
  caches and provider references.

## Verification

- `npm ci --include=dev`: passed, zero audit vulnerabilities. Source and updated
  `package-lock.json` are committed; Testing Library is a development dependency.
- `npm run check`: passed.
- `npm test -- --reporter=dot`: **67 tests, 12 files passed**.
- `bb plugin build bb-plugin-mcps`: passed (server, app, host bundles).
- `bb plugin reload mcps`: running from the confirmed permanent source.
- `bb plugin list`: all repo plugins still running from their permanent checkout
  paths; none of their source/settings were changed by this work.

Coverage includes empty registry, server errors, expired authorization during TTL
refresh, out-of-order snapshots, rapid server switching, query changes and clear,
500 tools, 60 installed servers, 140-server eviction, duplicate names, 30-way
inspection bursts, reconnect bursts, repeated disable/enable, cancellation during
refresh, concurrent installs, offline marketplace deadlines, and slow OAuth HTTP
request timeout. The existing OAuth timeout was already bounded; the test confirms
that behavior without changing authentication policy.

Live BB browser checks after reload:

1. Actual installed Composio (10 tools), Notion (44), and Infisical (10).
   Delayed Composio reads by 650 ms in the browser, switched away after 40 ms,
   repeated four cycles, then opened Infisical. **331 DOM samples, zero wrong-server
   tool names, eight aborted reads**, final Infisical list contained 10 tools.
   Browse verification job: `5d25d561-2e8e-4c5c-83e7-b83646517499`.
2. In the deployed UI, temporarily supplied browser-only RPC fixture responses
   for 60 servers and 500 tools. First list render: 69.8 ms; server pages: 50 then
   10 rows; tool pages: 50 rows, final tool `perf-tool-499` reachable.
   Browse verification job: `758df013-4943-4ed2-87e3-0cadd01c1aa1`.
   Restored native fetch and the actual registry immediately afterward. No fixture
   servers were installed and no account data was mutated.
3. Actual public registry repeat-cache measurement above.
   Browse verification job: `42b5dec1-e5be-41d8-b833-38b08bd19a76`.

## Limits

Tool pagination bounds DOM work; inspection still transfers the compact catalog
in one response. The installed SDK already walks MCP protocol list cursors.
Cancelling a browser HTTP read stops obsolete client work; it does not promise
cancellation of shared backend connection discovery. Registry network calls have
an eight-second deadline. Live tests used BB's loopback UI on its host; remote
Connect latency and native desktop behavior were not benchmarked. Live account
tokens were not deliberately expired, and live account connections were not
flapped; those failure cases use deterministic tests.
