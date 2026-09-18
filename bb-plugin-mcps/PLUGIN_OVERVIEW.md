BB has no built-in MCP registry. This plugin is that layer: the official MCP
Registry plus manual stdio and HTTP servers, normalized into one catalog that
every provider sees.

## What you get

- Search and add servers from `https://registry.modelcontextprotocol.io`.
- Add local stdio or remote HTTP/SSE servers by hand.
- Enable, disable, and OAuth from the MCPs sidebar page or `bb mcps`.
- Agent tools that search and call one tool at a time. They do not dump full
  schemas into the thread.

## How it works

Installed servers live in this plugin's storage. Isolated stdio workers run on
the BB host. Codex, Claude, and other providers all receive the same `mcps_*`
tools — BB has no Anthropic `mcp_toolset`, so discovery is search, not a
catalog dump.

## For agents

Use `mcps_search`, then `mcps_call` with the hit's `id` and input arguments. Use `mcps_schema` when full descriptions or constraints are needed. Prefer these over `agent_plugins_list_tools`.
