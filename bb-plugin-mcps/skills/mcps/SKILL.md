---
name: mcps
description: Use BB's MCP registry to search, inspect, and call MCP servers across every provider without dumping full tool catalogs.
---

# MCPs

BB has no built-in MCP registry. This plugin is that layer: official `server.json` registry plus manual stdio/HTTP servers, normalized into one catalog that every provider (Codex, Claude, others) sees through native `mcps_*` tools.

Do not call `agent_plugins_list_tools`. That dumps every schema into context. Use this plugin instead.

## Agent contract

1. `mcps_servers` — installed servers and status. No schemas.
2. `mcps_search` — ranked hits (default 5) with `opaqueId`, name, description, and a call card (`shape`, required fields, one example). Search matches tool names, descriptions, and parameter names. `unavailable` lists servers that timed out or failed to load.
3. `mcps_call` — invoke that `opaqueId` using the card as the argument template. Repeat the returned text in your reply so the user can see it.
4. `mcps_schema` — full input schema for one `opaqueId`. Use only when the call card is missing a field you need. Huge schemas come back as the card plus an `artifactPath`, not a 12k dump.

Search, then call. Skip schema unless the card is not enough.

Prompts and resources: `mcps_prompts` / `mcps_get_prompt`, `mcps_resources` / `mcps_read_resource`.
