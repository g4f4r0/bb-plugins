# Beacon

Beacon shows CPU, memory, disk, network, and processes for the machine that runs bb, right in the sidebar.

![Server status open in the bb sidebar footer](assets/screenshot.jpg)

Server status opens from the sidebar footer. An optional background monitor alerts you when CPU or memory stays high. It runs on its own 30-second timer, separate from the dashboard.

Beacon only reads system counters. It never changes server settings, enables swap, kills processes, or calls an outside service. It watches the bb server itself, not other enrolled machines, and it doesn't see a container's cgroup limits.

Needs bb 0.43 or newer and Plugin SDK 0.4.87. Network rates need Linux.

## Install

```sh
bb plugin install git:https://github.com/g4f4r0/bb-plugins.git --plugin beacon
```

Or name the subdirectory yourself:

```sh
bb plugin install git:https://github.com/g4f4r0/bb-plugins.git --subdirectory bb-plugin-beacon
```

On this server, Beacon installs from release tags (`git:https://github.com/g4f4r0/bb-plugins.git@semver:beacon/:^0.1.0`), not from the checkout. To ship a change, merge it, tag the next `beacon/vX.Y.Z`, and run `bb plugin update beacon`.

The [bb Community listing](https://getbb.app/marketplace) follows the same `beacon/vX.Y.Z` tags, with `subdir` `bb-plugin-beacon` and `tagPrefix` `beacon/`. It was added in [get-bb/marketplace PR 279](https://github.com/get-bb/marketplace/pull/279). Any new tag within `^0.1.0` reaches it without changing the listing.

## Settings

| Setting | Key | Default | What it does |
| --- | --- | --- | --- |
| Refresh interval (seconds) | `refreshIntervalSeconds` | `5` | How often Server status updates while it's open. Whole seconds, 2 to 60. |
| Background monitoring | `backgroundMonitoring` | Off | Checks CPU and memory every 30 seconds, even when Server status is closed, and keeps diagnostic logs. |
| Overload alerts | `pressureNotifications` | On | Alerts in bb when CPU or memory stays high, and again when it recovers. Needs background monitoring. |

From a terminal:

```sh
bb plugin config beacon
bb plugin config beacon set refreshIntervalSeconds 10
bb plugin config beacon set backgroundMonitoring true
bb plugin config beacon set pressureNotifications false
```

Changes apply without a reload.

The refresh interval doesn't affect the monitor, which always checks every 30 seconds. Turning monitoring off stops its timer and keeps the logs it already wrote.

## Commands

| Command | Result |
| --- | --- |
| `bb beacon snapshot` | Summary of CPU, load, memory, disk, and processes. |
| `bb beacon snapshot --json` | The full snapshot, including recent chart history. |
| `bb beacon health` | Pressure check. Exits 2 when critical. |
| `bb beacon health --json` | The same check as JSON. Always exits 0, so read `status`. |
| `bb beacon logs` | The last 100 diagnostic records. |
| `bb beacon logs --limit 500 --json` | Up to 500 records as JSONL, oldest first. |
| `bb beacon test-alert` | A labeled test alert in every open, visible bb window. |

`test-alert` needs background monitoring and overload alerts both on. It doesn't create load, incidents, or log rows, and it reaches every connected client.

CLI snapshots use the same collector as the dashboard, so calling them repeatedly keeps chart history alive. Reading logs doesn't.

## What the numbers mean

**CPU.** The change between two samples, so the first sample has no value. Per-core values work the same way. The dashboard, CLI, and alerts share one definition. On Linux that's `/proc/stat`, counting I/O wait as idle and hypervisor steal as busy, the way `top` does.

**Load average.** 1, 5, and 15 minutes. Not a percentage.

**Memory.** Used is total minus available. On Linux, available is `MemAvailable`. Cache is `Cached` plus `SReclaimable`. Cache and buffers are context and don't count as used.

**Swap.** Shows only when the server reports a swap total above zero. Beacon never creates swap.

**Disk.** The `/` filesystem. Used is allocated blocks. Free leaves out reserved blocks, so used plus free can come up short of total.

**Network.** Bytes received and sent per second on the non-loopback interface with the most traffic since boot. It isn't a sum across interfaces. Rates go blank when that interface changes or its counters reset. Linux only.

**Processes.** Snapshots list the top six by lifetime-average CPU, with PID breaking ties, and Server status shows the first three. Process CPU is relative to one core, so it can pass 100%, and it isn't host CPU. Beacon lists processes with `ps`, with a 1.5-second timeout and a 512 KiB output cap, and on Linux takes names from `/proc/<pid>/exe`. It never reads command-line arguments. When the scan fails, the snapshot reports `processes.available: false`, and its zero counts don't mean the machine is idle.

**Runtime.** The whole bb server process, including every loaded plugin, not Beacon alone.

Byte sizes use powers of 1024. Network is in bytes per second, not bits.

## How Server status updates

Server status polls only while it's on screen. Closing it keeps the last snapshot, so reopening shows numbers right away instead of placeholders. The bottom row shows when that snapshot was taken and has a button for a fresh one. If the view remounts, it reuses any request already in flight, along with the same cadence and offline backoff.

The server caches each snapshot for 15 seconds or twice the refresh interval, whichever is longer, then drops the history. After that, CPU and network need a second sample again. Raising the refresh interval extends the current cache too. History holds at most 72 points. When requests fail, Beacon backs off from 5 seconds up to 60.

Meters are green below 75%, amber from 75%, and red from 95%. Colors never trigger alerts.

## Background alerts

While monitoring is on, the server checks CPU and memory every 30 seconds. It doesn't run `ps` or touch disk, network, or chart history.

| Metric | Alert when | Recovered when |
| --- | --- | --- |
| CPU | 95% or more for 60 seconds | 85% or less for 60 seconds |
| Memory | 90% or more for 60 seconds | 85% or less for 60 seconds |

You get one alert when an overload starts and one when it recovers, then a five-minute cooldown for that metric. bb has to be open and visible to show them. There's no OS push and no notification inbox.

`bb beacon health` uses its own scale. It warns at 85% and is critical at 95% for CPU, memory, or disk, and it also compares five-minute load with core count. It doesn't wait a minute first. Meter colors, CLI health, and alerts are three separate scales on purpose.

`bb beacon logs` reads Beacon's rotating diagnostics. `bb plugin logs beacon` is the plugin's runtime log. Don't edit the live SQLite file.

```sh
bb beacon logs --limit 500 --json > beacon-diagnostics.jsonl
```

## Develop

```sh
bb plugin types --check
npm test
npm run typecheck
bb plugin build
```

`bb plugin types --check` reports an SDK mismatch without changing anything. Tests in `tests/` cover parsing, hide and show races, pressure state, alert copy, and CPU counters.

The installed Beacon follows release tags, so `bb plugin reload beacon` won't pick up local edits. To try a change live, copy the folder, give the copy another package name such as `bb-plugin-beacon-dev`, and install it from its path. Remove it afterwards with `bb plugin remove beacon-dev`. Never remove `beacon` itself, because removing a plugin deletes its settings.

For a UI change, open Server status, wait for two samples, try a 390px-wide window, then hide the tab and check that polling stops. Use `bb beacon test-alert` instead of loading the server.

## Troubleshooting

**Charts reset.** The server history expired. CPU and network show a dash until the second sample. Logs are separate and unaffected.

**Memory is amber but no alert came.** Amber starts at 75%. Memory alerts need 90% for a full minute.

**No alert appeared.** Check that background monitoring and overload alerts are both on, keep bb visible, and try `bb beacon test-alert`. Real alerts also wait for the one-minute confirmation and the cooldown.

**Logs are empty.** Background monitoring is off by default.

**Network says unavailable.** It needs Linux, a readable non-loopback interface, and two samples.

**A process shows more than 100% CPU.** That's its lifetime average across more than one core.

**A change doesn't show up.** The installed copy follows release tags. Tag a release and run `bb plugin update beacon`. If the update fails, bb keeps the previous version.
