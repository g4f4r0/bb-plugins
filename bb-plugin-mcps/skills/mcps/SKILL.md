---
name: mcps
description: Discover and call installed MCP tools, prompts, and resources without loading full catalogs.
---

# MCPs

- Start with `mcps_search`; it searches every enabled server. Do not call
  `mcps_servers` first unless the task is to inspect installations/status or a
  search reports an unavailable server.
- `mcps_servers`: paginated installed MCPs (`id`, `handle`, transport, status,
  known tool count). Missing count means unknown, never zero. Pass `cursor`
  from `nextCursor`; use `query` to filter and `details:true` for diagnostics.
- `mcps_search`: ranked tools with `id`, readable `server`, description and
  `input`. Use a short capability phrase. Filter `server` by ID or handle when
  it is already known. Usually omit `limit`; values above 12 are capped rather
  than rejected. Input keys use dotted paths for nesting and `?` for optional
  fields.
  `unavailable` is present only when a server cannot supply its catalog.
- `mcps_call`: pass the discovered `id` and `args`. Report useful results to
  the user; the UI may show only a success envelope.
- `mcps_schema`: fetch full descriptions and constraints when input is
  insufficient or `schemaRequired:true`. Read `artifactPath` for large schemas.

Prompts and resources follow the same `id` contract: `mcps_prompts` →
`mcps_get_prompt`, `mcps_resources` → `mcps_read_resource`. Both discovery
calls accept a `server` filter. Truncated outputs retain full data in artifacts.

Use these lazy tools instead of `agent_plugins_list_tools`. Do not load whole
catalogs. Keep normal discovery compact; request details only when needed.
