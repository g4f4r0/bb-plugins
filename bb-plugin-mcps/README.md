# MCPs

BB plugin that is the MCP registry for every provider: official registry plus
manual stdio/HTTP servers, exposed as a small lazy catalog (`mcps_search` with
call cards, then `mcps_call`; `mcps_schema` only when the card is not enough)
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
