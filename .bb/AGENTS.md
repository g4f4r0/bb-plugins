# Custom BB plugins

This repo is the live source for the custom plugins. GitHub copy:
https://github.com/g4f4r0/bb-plugins. Read the README before creating,
changing, installing, or recovering one.

Agent Plugins stays at `/home/g4f4r0/.bb/local-plugins/bb-plugin-agent-plugins`.

- Never install a plugin from a personal thread workspace, temporary directory, or disposable worktree. Archiving a thread can delete its workspace and every installed plugin inside it.
- Resolve the installed source with `bb plugin source <id> --json` before editing. Edit the permanent source, not an old workspace copy.
- Keep the existing plugin ID. Changing it drops settings. Recover original source where possible. Do not rebuild a partial approximation and call it complete.
- Keep source and lockfiles in Git. Verify checks and live behavior, commit, then `bb plugin build` and `bb plugin reload <id>`. To point an existing install at a new folder without wiping settings, `bb plugin install path:/absolute/permanent/package --yes`. `bb plugin remove` deletes settings.
- After a deploy, `bb plugin list` should show the repo plugins running from this checkout. Check all of them if one looks wrong.
- GitHub is the off-server copy of the custom plugin source.
