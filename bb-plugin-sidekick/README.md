# Sidekick

Sidekick is an isolated fork of Dmitrii Kapustin's MIT-licensed Agent Roles
plugin. It keeps reusable agents and removes teams, DAGs, task presets, file
synchronization, visual workflows, and agent-to-agent handoffs.

New installations start with an empty agent store. Sidekick never seeds
examples automatically.

## Scope

- Create, read, update, and delete reusable agents in Sidekick-owned SQLite.
- Store agent instructions, provider/model/reasoning/service-tier/permission
  defaults, and preferred skills.
- Store one shared instruction block in Sidekick's plugin settings for every
  agent.
- Choose execution defaults with BB's native live provider/model picker, the
  same picker used by the composer.
- Search and select skills discovered by BB instead of typing skill names.
- Start exactly one visible, agent-bound BB thread in an explicitly selected
  project.
- Inject shared instructions first and the selected agent's instructions second
  when the provider session starts.

Sidekick does not provide an orchestrator conversation, teams, DAGs, task
presets, visual workflows, handoffs, live-agent objects, or automations.

## Two instruction levels

1. Open **Settings → Installed plugins → Sidekick** and set **Instructions for
   all agents** for shared rules.
2. Set **Agent instructions** for identity, responsibilities, boundaries, and
   working style. There is no separate behavior field; behavior belongs in the
   agent's instructions.

The shared field accepts up to 1,200 characters. BB limits the combined dynamic
instruction block to 4,096 characters. Setting changes take effect when the
provider session next starts.

```sh
bb plugin config sidekick set sharedInstructions "Your shared instructions"
```

## UI

Open **Agents** in the app sidebar. The editor uses BB's live provider catalog
for provider, model, reasoning, service tier, and permission controls. Its skill
picker lists skills BB discovers on this installation and stores up to 12 names
per agent.

The Plugin SDK cannot activate skills owned by another plugin or provider.
Sidekick therefore includes selected names in hidden instructions and asks the
agent to use them when they are available in that session.

## CLI

```sh
bb sidekick list
bb sidekick show <agent>
bb sidekick create --slug <slug> --name <name> --instructions <text>
bb sidekick update <agent> \
  --provider pi \
  --model openai-codex/gpt-5.5 \
  --reasoning medium \
  --permission full \
  --skills research,reporting
bb sidekick delete <agent>
bb sidekick spawn <agent> \
  --prompt "Do the focused task" \
  --project proj_123 \
  --title "Optional title" \
  --wait
```

`--project` is always required for `spawn`; Sidekick never infers it from the
current thread. Omit `--wait` to return immediately with the new thread ID. Add
`--json` to any command for machine-readable output.

## Development

```sh
npm ci --include=dev
bb plugin types --check .
npm run typecheck
npm test
npm run build
```

## Attribution and license

Forked from
[`plugins/agent-roles`](https://github.com/dmitriikapustin/bb-plugins-by-kapustin/tree/0413c6498f683eeb3d5161f1cc5956b5d7639499/plugins/agent-roles)
by Dmitrii Kapustin. The original MIT license and copyright notice are retained
in [LICENSE](LICENSE).
