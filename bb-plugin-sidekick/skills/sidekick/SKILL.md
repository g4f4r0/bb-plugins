---
name: sidekick
description: Manage reusable Sidekick agents and start exactly one agent-bound BB thread in an explicit project.
---

# Sidekick

Sidekick stores reusable agents. Each agent has one instruction field for its
identity, responsibilities, boundaries, and working style, plus optional
provider, model, reasoning, service-tier, permission, and skill defaults.

Shared rules live under **Settings → Installed plugins → Sidekick → Instructions
for all agents** and are injected before agent-specific instructions. The
sidebar editor uses BB's native provider/model picker and a searchable catalog
of skills discovered by BB.

Sidekick does not orchestrate teams or workflows. One spawn command creates one
visible BB thread. Always pass the target project explicitly.

## Commands

```text
bb sidekick list [--json]
bb sidekick show <agent> [--json]
bb sidekick create --slug <slug> --name <name> --instructions <text> [agent defaults] [--json]
bb sidekick update <agent> [agent fields] [--json]
bb sidekick delete <agent> [--json]
bb sidekick spawn <agent> --prompt <task> --project <projectId> [--title <title>] [--wait] [--json]
```

Agent defaults:

```text
--description <text>
--provider <id|inherit>
--model <id|inherit>
--reasoning <none|low|medium|high|xhigh|max|ultra|ultracode|inherit>
--service-tier <default|fast|inherit>
--permission <accept-edits|auto|full|inherit>
--skills <comma-separated skill names>
```

Provider and model must both be set or both inherit. Service tier requires an
explicit provider/model pair. On update, pass `inherit` to clear execution
defaults. Pass `--skills ""` to clear skills.

Shared and agent instructions are injected through `bb.agents.configure` when
the provider session starts; they are not added to the task message. Selected
skill names are included as a request to use those skills when available. The
Plugin SDK does not let one plugin activate another plugin's skill registration.

`--wait` waits for the spawned thread to become idle and prints its last output.
Without it, the command prints the new thread ID. Sidekick never infers a project
from the invoking thread: `--project` is mandatory.
