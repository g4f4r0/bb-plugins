# Custom BB plugins

Source for Browse, Beacon, Sidetree, MCPs, and Wayfinder. BB loads the installed plugins in place from this checkout. Browse is retained as source but is no longer installed; Cua Driver and BB Browser Automation have also been removed from BB. Do not reinstall them as part of Wayfinder work.

Wayfinder is implemented and under active release hardening: see [the implementation plan](bb-plugin-wayfinder/PLAN.md). The GitHub remote is [https://github.com/g4f4r0/bb-plugins](https://github.com/g4f4r0/bb-plugins)

Do not install these from a thread workspace, `/tmp`, or a throwaway worktree. If the thread is archived, BB deletes the directory. The plugin entry survives, pointing at a hole.


| Plugin   | ID         | Directory            |
| -------- | ---------- | -------------------- |
| Browse   | `browse`   | `bb-plugin-browse`   |
| Beacon   | `beacon`   | `bb-plugin-beacon`   |
| Sidetree | `sidetree` | `bb-plugin-sidetree` |
| MCPs     | `mcps`     | `bb-plugin-mcps`     |
| Wayfinder | `wayfinder` | `bb-plugin-wayfinder` |


Keep these IDs. Change the id and BB treats it as a new plugin and drops its settings. Agent Plugins is a separate local package at `/home/g4f4r0/.bb/local-plugins/bb-plugin-agent-plugins`.

`.bb/plugins.json` lists the packages so a git install can pass `--plugin <id>`. Example: `bb plugin install git:https://github.com/g4f4r0/bb-plugins.git --plugin beacon`.

## Deploy

1. Check the live path with `bb plugin source <id> --json`. Edit that package, not an old workspace copy. Leave unrelated dirty files alone.
2. Restore deps with `npm ci --include=dev` if `node_modules` is missing. Run the package typecheck and tests. Browse and Beacon have real suites.
3. Commit the reviewed files. A committed `package-lock.json` is required.
4. For Browse, finish or release every active session first.
5. Build, then reload or point the install at this folder:

```sh
bb plugin build bb-plugin-<id>
bb plugin reload <id>
```

If this checkout is not the live source yet:

```sh
bb plugin install path:/home/g4f4r0/projects/bb-plugins/bb-plugin-<id> --yes
```

Path-to-path install keeps settings. `bb plugin remove` deletes them. Do not remove a plugin just to move its source.

6. Use the feature in BB. A passing typecheck does not mean the UI works.

Optional snapshot before a risky reload:

```sh
mkdir -p ~/.bb/plugin-backups
git bundle create ~/.bb/plugin-backups/<id>-$(date -u +%Y-%m-%dT%H-%M-%SZ).bundle --all
```

Those bundles live on this machine. GitHub is the copy that survives if the disk does not.

After install, `bb plugin list` should show each intentionally installed repo plugin as `running` from `path:/home/g4f4r0/projects/bb-plugins/bb-plugin-<id>`. Browse is intentionally uninstalled; Wayfinder is installed from its permanent package in this checkout. If one custom plugin looks wrong, check all of them. Shared install mistakes tend to hit more than one.

For a new plugin, run `bb plugin new <id>` here, commit source and lockfile, then the path install above.

The Dusk look (palette, status sidebar, composer, wallpaper) is built into the
hellogafaro/bb fork; it is no longer a plugin.

## What belongs where

Git holds source and lockfiles. `dist/` and `node_modules/` are ignored.

BB keeps settings, KV, browser profiles, and secrets under its own data directory. Do not copy those into this repo.

Server-wide agent notes are in `/home/g4f4r0/.bb/AGENTS.md`. They point here. BB core still lets you install from anywhere.