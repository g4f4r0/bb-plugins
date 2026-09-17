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
