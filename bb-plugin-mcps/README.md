# MCPs

BB plugin that is the MCP registry for every provider: official registry plus
manual stdio/HTTP servers, exposed as a small lazy catalog (`mcps_search` with
compact input maps, then `mcps_call`; `mcps_schema` when more detail is needed)
instead of dumping every schema into context.

Permanent source: `/home/g4f4r0/projects/bb-plugins/bb-plugin-mcps`.
Install from that path. Do not install from a thread workspace.

```
npm ci --include=dev
npm test
npx tsc --noEmit
bb plugin build
bb plugin install path:/home/g4f4r0/projects/bb-plugins/bb-plugin-mcps --yes
```

CLI: `bb mcps list`, `bb mcps registry <query>`, `bb mcps add <name> <url|registry-id>`,
`bb mcps auth <id>`, `bb mcps remove <id>`. Adding a server enables it. Tools run as the MCP
server defines them; no extra confirmation layer.

## Reliability checks

Run `npm run check` and `npm test`. `tests/reliability.test.ts` exercises the real
MCP client against deterministic HTTP responses: 200 tool calls in five expiry
waves, rotating refresh tokens, delayed 401s, paginated catalogs, fresh credential
store reloads, OAuth outages, expired MCP sessions, missing credentials, and
concurrent credential writes.

Concurrent 401 responses share one OAuth exchange. Temporary OAuth network,
429, and 5xx failures preserve credentials for the next attempt. Failed secret
writes retry up to five times with exponential backoff (1–16 seconds); retries
stop when the plugin is disposed. A failed catalog refresh reports the server
as unavailable and retries after the existing five-second backoff. An expired
MCP session is discarded so the next request reconnects; failed tool calls are
not automatically replayed after session or network errors.

Providers can still revoke authorization or require renewed consent. Stress
fixtures do not expire real account tokens or simulate every provider policy.

## IDs and context

MCP installations expose a stable `mcp_` ID and a separate readable `handle`.
Tools, prompts, resources and resource templates use `mcpt_`, `mcpp_`, `mcpr_`
and `mcprt_` IDs. Agent results and calls consistently use `id`. Existing handles,
old capability IDs and previous `toolId`/`promptId`/`resourceId`/`opaqueId` inputs
remain accepted. Existing storage and OAuth keys are retained internally so this
migration does not invalidate credentials; `serverId: "mcp"` was the old internal
connection name, not a global identity.

`mcps_servers` returns 20 entries by default, with a cursor for more. Known zero
tool counts are retained; unknown counts are omitted. Installation metadata,
empty descriptions and prompt/resource counts are available via `details:true`.
The management UI and `bb mcps show <id-or-handle>` retain full diagnostics.
`bb mcps list --json` is compact; `--details` adds diagnostic metadata.

Search emits one input map instead of overlapping shape/field/example objects.
`?` marks optional fields; dots represent nested argument objects. Common value
constraints remain visible, and complex or truncated schemas are explicitly
marked `schemaRequired`. Use the `server` filter on tool, prompt and resource
discovery to avoid unrelated connections. Tool search works directly across
enabled servers, so agents do not need to list servers first. Its optional
result limit is capped at 12 instead of rejecting oversized requests. JSON
responses are compact, empty availability lists are omitted, and oversized
discovery responses remain valid JSON with a full-data artifact link. Agent
output defaults to 8,000 characters.
