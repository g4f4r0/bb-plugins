# Beacon

See CPU, memory, disk, and processes on the BB server from the footer.

![Status in the BB footer](assets/screenshot.jpg)

Status sits in the sidebar footer. Open it while you work. An optional background monitor can toast when CPU or memory stays high. The two collectors do not share a timer.

Beacon reads system counters. It does not change server settings, enable swap, kill processes, or call a monitoring service. It watches the BB server host only, not other enrolled machines or a container's cgroup limit.

Needs BB 0.43 and Plugin SDK 0.4.87. Network rates need Linux or macOS.

## Install

From this repository:

```sh
bb plugin install git:https://github.com/g4f4r0/bb-plugins.git --plugin beacon
```

Same thing with an explicit subdirectory:

```sh
bb plugin install git:https://github.com/g4f4r0/bb-plugins.git --subdirectory bb-plugin-beacon
```

On this server the live path is already `bb-plugin-beacon` in the checkout. Reload after a source change:

```sh
bb plugin build bb-plugin-beacon
bb plugin reload beacon
```

The [BB Community listing](https://getbb.app/marketplace) tracks `beacon/vX.Y.Z` tags with `subdir` `bb-plugin-beacon` and `tagPrefix` `beacon/`. It was added in [get-bb/marketplace PR 279](https://github.com/get-bb/marketplace/pull/279). Publish a new tag within its `^0.1.0` range to make a compatible release available without changing the listing.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `refreshIntervalSeconds` | `5` | Dashboard interval, integer 2 to 60. |
| `backgroundMonitoring` | `false` | Unattended CPU and memory checks plus diagnostic logs. |
| `pressureNotifications` | `true` | In-app toasts when monitoring is on. |

```sh
bb plugin config beacon
bb plugin config beacon set refreshIntervalSeconds 10
bb plugin config beacon set backgroundMonitoring true
bb plugin config beacon set pressureNotifications false
```

Settings apply without a reload. The dashboard interval does not change the monitor's 30-second cadence. Turning monitoring off cancels its timer and leaves existing logs.

## Commands

| Command | Result |
| --- | --- |
| `bb beacon snapshot` | CPU, load, memory, disk, and process summary. |
| `bb beacon snapshot --json` | Full snapshot, including recent chart history. |
| `bb beacon health` | Pressure assessment. Exit 2 if critical. |
| `bb beacon health --json` | Structured assessment. Exit 0 always; read `status`. |
| `bb beacon logs` | Last 100 diagnostic records. |
| `bb beacon logs --limit 500 --json` | Up to 500 records as JSONL, oldest first in that window. |
| `bb beacon test-alert` | Labeled toast preview on visible BB clients. |

`test-alert` needs monitoring and notifications both on. It does not create load, incidents, or log rows. It broadcasts to every connected client.

CLI snapshots share the dashboard collector. Repeated calls keep history alive. Reading logs does not.

## What the numbers mean

CPU percent is the change between samples. The first sample has no percent. Per-core values follow the same rule.

Load averages are 1, 5, and 15 minutes. They are not CPU percents.

Memory used is total minus available. On Linux, available is `MemAvailable`. On macOS, available is free plus inactive, speculative and purgeable pages, so cached files are not counted as used; cache is the file-backed page count. Apple's Memory Used is app, wired and compressed memory instead, so the two figures may differ; Beacon is not calibrated against Activity Monitor. Cache and buffers are supporting counters, not extra used memory. If those counters cannot be read, memory shows as unavailable and is left out of health and alerts.

Swap appears only when a swap total greater than zero is readable. Beacon never creates it.

Disk is `/`. The row shows used space on the filesystem mounted at `/`, the meter's basis: total minus free blocks. On Linux that excludes separate mounts and partitions. On macOS, where `/` is one volume of an APFS container whose volumes share space, the same call reports container-wide usage and matches `diskutil info /`; `df` on `/` reports only the read-only system volume, and the volume that fills is `/System/Volumes/Data`. Reserved blocks can make used plus writable free space add up to less than total.

Network is received and sent bytes per second on the non-loopback interface with the most cumulative traffic. Not a sum of interfaces. Rates go unavailable when the interface changes or counters reset. Linux and macOS; other platforms report no interface.

Snapshots list six PIDs by lifetime-average CPU, PID as tie-break. The popover shows the first three. Process CPU is relative to one core and can exceed 100%. That is not the sampled host CPU.

Runtime is the BB server process, including loaded plugins, not Beacon alone.

Byte labels use powers of 1024. Network is bytes per second, not bits.

A failed process scan returns `processes.available: false`. Zero counts in that result do not prove the machine is idle. The scan runs `ps` with a 1.5-second timeout and a 512 KiB cap. On Linux it resolves names through `/proc/<pid>/exe`. It does not read argv.

## How Status works

The popover polls only while it is visible. Closing it keeps one last snapshot per app bundle, with no timer or thread keys, so reopening does not replay placeholders. The footer shows when the snapshot was updated and can request a fresh sample immediately. Remounts share an in-flight request, sampling cadence, and offline backoff. The server keeps a shared cache for the greater of 15 seconds and twice the dashboard interval, then forgets history. Reopening after that starts cold, so CPU and network need a second sample.

Increasing the dashboard interval also extends the existing server cache expiry. History holds at most 72 points. Visible failures back off from 5 seconds to 60. Meters are green below 75%, amber from 75%, red from 95%. Those colors do not fire alerts.

## Background alerts

While monitoring is on, the server samples CPU and memory every 30 seconds. No `ps`, no disk, no network, no chart history.

CPU incident: at least 95% for 60 seconds of samples. Recovers at or below 85% for 60 seconds.
Memory incident: at least 90% for 60 seconds. Recovers at or below 85% for 60 seconds.

One toast at start, one at recovery, then a five-minute cooldown per metric. BB must be open and visible. No OS push, no notification inbox.

CLI health warns at 85% and is critical at 95% for CPU, memory, or disk, and it also compares five-minute load with core count. That check has no confirmation window. Dashboard color, CLI health, and toasts are three different scales.

`bb beacon logs` reads Beacon's rotating diagnostics. `bb plugin logs beacon` is the plugin runtime log. Do not edit the live SQLite file.

```sh
bb beacon logs --limit 500 --json > beacon-diagnostics.jsonl
```

## Develop

```sh
bb plugin types --check
npm test
npm run typecheck
bb plugin build
bb plugin reload beacon
```

`bb plugin types --check` reports an SDK mismatch without writing. Tests live in `tests/`. They cover parsing, hide/show races, pressure state, and alert copy.

For a UI change, open Status, wait for two samples, try a 390px width, then hide the tab and confirm polling stops. Use `bb beacon test-alert` instead of overloading the server.

## Troubleshooting

Charts reset after the server history expires. CPU and network then show a dash until a second sample. Initial placeholders are static; subsequent opens retain the last snapshot. Meters animate transforms and respect reduced motion. Logs are separate from charts.

Memory is amber with no toast. Amber starts at 75%. Memory alerts need 90% for a full minute of samples.

Memory may differ from Activity Monitor. Beacon treats inactive and purgeable pages as available; Apple's Memory Used is app, wired and compressed memory. Neither counts cached files as used.

Memory says unavailable. The counters could not be read. Health and alerts skip memory in that state.

No toast appeared. Check both settings, keep BB visible, try `test-alert`. Real alerts also wait on confirmation and cooldown.

Logs are empty. Monitoring is off by default.

Network says unavailable. Needs Linux or macOS and a readable non-loopback interface, then two samples.

A process shows more than 100% CPU. Lifetime average on more than one core.

A change is not visible. Build and `bb plugin reload beacon`. If reload fails, BB keeps the previous generation.
