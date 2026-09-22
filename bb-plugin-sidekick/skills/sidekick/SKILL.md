---
name: sidekick
description: Manage reusable Sidekick profiles and start exactly one profile-bound BB thread in an explicit project.
---

# Sidekick

Sidekick stores reusable profiles. Each profile can define hidden instructions,
behavior preferences, preferred skill names, and optional provider, model,
reasoning, and permission defaults.

Sidekick does not orchestrate teams or workflows. One spawn command creates one
visible BB thread. Always pass the target BB project explicitly.

## Commands

```text
bb sidekick list [--json]
bb sidekick show <profile> [--json]
bb sidekick create --slug <slug> --name <name> --instructions <text> [profile defaults] [--json]
bb sidekick update <profile> [profile fields] [--json]
bb sidekick delete <profile> [--json]
bb sidekick spawn <profile> --prompt <task> --project <projectId> [--title <title>] [--wait] [--json]
```

Profile defaults:

```text
--description <text>
--provider <id|inherit>
--model <id|inherit>
--reasoning <none|low|medium|high|xhigh|max|ultra|ultracode|inherit>
--permission <accept-edits|auto|full|inherit>
--skills <comma-separated skill names>
--behavior <text>
```

Provider and model must both be set or both inherit. On update, pass `inherit`
to clear provider, model, reasoning, or permission defaults. Pass an empty
`--skills ""` or `--behavior ""` value to clear those fields.

Profile instructions and behavior are injected through `bb.agents.configure`
when the provider session starts; they are not added to the task message.
Preferred skill names are included in that hidden instruction block as a
request to use the skills when available. The current Plugin SDK does not let
one plugin activate another plugin's skill registration.

`--wait` waits for the spawned thread to become idle and prints its last output.
Without `--wait`, the command prints the new thread ID. Sidekick never infers a
project from the invoking thread: `--project` is mandatory even when the
command runs inside a project thread.
