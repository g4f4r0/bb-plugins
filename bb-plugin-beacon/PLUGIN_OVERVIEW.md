## What you get

Server status shows CPU, per-core load, memory, swap, root disk, network rates, top processes, and uptime for the machine that runs bb. It opens from the sidebar footer and samples only while it's on screen.

`bb beacon snapshot` prints the same numbers in a terminal, and `--json` gives the full reading. `bb beacon health` checks for pressure and exits 2 when something is critical.

Turn on background monitoring to check CPU and memory every 30 seconds, even with Server status closed. A sustained overload shows an alert in bb, which has to be open and visible. There's no OS push and no third-party monitor.

## How it works

Meters turn amber at 75% and red at 95%. CLI health warns at 85%, is critical at 95%, and also compares five-minute load with core count. Background alerts use higher thresholds and wait a full minute first. The three scales are separate on purpose.

Metrics stay on the bb server. Chart history lives in memory and expires when nobody is looking. Beacon never calls an outside service, changes server settings, enables swap, or kills processes.

## Requirements

Needs bb 0.43 or newer. Beacon watches only the bb server, not other enrolled machines or containers. Network rates need Linux. A process can show more than 100% CPU because that figure is a lifetime average relative to one core.

No account, API key, or extra install.
