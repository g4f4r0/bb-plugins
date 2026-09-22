# Sidekick

Sidekick is an isolated v1 fork of Dmitrii Kapustin's MIT-licensed Agent Roles
plugin. It keeps the reusable-profile idea and removes teams, DAGs, task
presets, file synchronization, visual workflows, and agent-to-agent handoffs.

The installed store starts empty. Sidekick never seeds example profiles.

## Scope

- Create, read, update, and delete reusable profiles in Sidekick-owned SQLite.
- Store profile-specific hidden instructions plus provider, model, reasoning,
  permission, preferred-skill, and behavior defaults.
- Store one shared instruction block in Sidekick's plugin settings for every
  Sidekick profile.
- Start exactly one visible, profile-bound BB thread in an explicitly selected
  project.
- Inject shared instructions first and the selected profile's instructions
  second with `bb.agents.configure` when the provider session starts.
- Record profile identity in Sidekick's thread metadata namespace.
- Use the sidebar page or an automation-friendly `bb sidekick` command.

Sidekick does not provide an orchestrator conversation, teams, DAGs, task
presets, visual workflows, handoffs, live agents, or automations.

## Two instruction levels

1. Open **Settings → Installed plugins → Sidekick** and set **Instructions for
   all profiles** for rules every Sidekick should follow.
2. Set **Profile instructions** in each profile for that Sidekick's identity,
   responsibilities, and working style.

Shared instructions are injected before profile instructions, matching a
shared-then-specific composition model. They apply only to Sidekick-created
profile threads. The shared field accepts up to 1,200 characters; BB limits the
combined dynamic instruction block to 4,096 characters. Setting changes take
effect when a provider session next starts; they do not rewrite existing task
messages.

The same shared setting can be managed from the CLI:

```sh
bb plugin config sidekick set sharedInstructions "Your shared instructions"
```

## CLI

```sh
bb sidekick list
bb sidekick show <profile>
bb sidekick create --slug <slug> --name <name> --instructions <text>
bb sidekick update <profile> --behavior <text>
bb sidekick delete <profile>
bb sidekick spawn <profile> \
  --prompt "Do the focused task" \
  --project proj_123 \
  --title "Optional title" \
  --wait
```

`--project` is always required for `spawn`; Sidekick does not infer it from the
current thread. Omit `--wait` to return immediately with the new thread ID.
Add `--json` to any command for machine-readable output.

Run `bb sidekick help` or read [the bundled skill](skills/sidekick/SKILL.md) for
all profile fields.

## Skills limitation

Profiles retain preferred skill names. Sidekick places those names in the
hidden profile instruction block and asks the agent to use them when available.
The current BB Plugin SDK only lets a plugin select skills from its own static
manifest, so Sidekick cannot directly activate skills owned by another plugin
or user directory.

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
