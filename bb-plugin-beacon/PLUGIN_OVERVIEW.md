## What you get

Status lives in the sidebar footer. Open it for CPU, per-core load, memory, swap, root disk use, network rates, top processes, and uptime on the machine that runs BB. The popover samples only while it is on screen.

`bb beacon snapshot` prints the same numbers in a terminal. Add `--json` for the full structured reading. `bb beacon health` reports pressure and exits 2 when a reading is critical.

Turn on background monitoring to watch CPU and memory every 30 seconds while Status is closed. Sustained overload can send an in-app toast. BB has to be open and visible to show it. There is no OS push and no third-party monitor.

## How it works

Dashboard colors turn amber at 75% and red at 95%. CLI health warns at 85% and goes critical at 95%. It also compares five-minute load with core count. Background alerts wait a full minute of samples at higher thresholds. Those scales are independent on purpose.

Metrics stay on the BB server. Chart history is memory-only and expires when nobody is looking. Beacon never calls an external API. It does not change server settings, enable swap, or kill processes.

## Requirements

Needs BB 0.43 or newer. It inspects only the BB server host, not other enrolled machines or containers. Detailed network rates need Linux or macOS. Memory and swap counters need Linux or macOS. A process can show more than 100% CPU because that figure is a lifetime average relative to one core.

No account, API key, or extra install.
