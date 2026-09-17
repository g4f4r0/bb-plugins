# Monitor measurements

Run on Linux from the Beacon package:

```sh
npm ci --include=dev
npm run benchmark:monitor
node benchmarks/contention.mjs
```

The monitor benchmark runs the **production server plugin**, real `/proc` reads,
and real SDK-owned SQLite, with 200 warmup samples followed by 10,000 measured
samples. Pass a count from 100 to 50,000 as the final argument. Node's mock clock
advances the 30-second intervals; wall durations and CPU costs use real clocks.
This is accelerated sampling, not an 83-hour wall-clock soak.

A temporary directory inside `benchmarks/` keeps SQLite on the checkout's
filesystem rather than a potentially RAM-backed `/tmp`. It is deleted on normal
completion. The harness database is explicitly put in WAL mode to match the
public live SDK contract. SQLite commits are timed separately from the complete
sample. No measurements touch the live database or change plugin settings.

`processWriteBytes` comes from `/proc/self/io`. Heap checkpoints use explicit GC
and include the complete isolated test process, not just Beacon allocations.
The benchmark avoids mock function call histories that would distort retention.
It verifies the log-row bound, clean service shutdown, and no writes after a
further ten simulated minutes. The CPU measurements include benchmark overhead.

The contention benchmark holds a writer lock on a separate connection to its
own temporary database. It measures attempted transactions and blocking time,
then verifies successful sampling after the lock is released. It never locks the
live database.

## Results on 2026-09-17

| Measurement | Baseline | Final |
| --- | ---: | ---: |
| Samples | 10,000 | 10,000 |
| Complete sample mean / p95 | 1.033 / 6.277 ms | 0.851 / 5.265 ms |
| SQLite commit mean / p95 | 0.667 / 5.454 ms | 0.546 / 4.578 ms |
| Process CPU per sample | 0.577 ms | 0.469 ms |
| Retained heap at 2,000 / 10,000 samples | 11.57 / 11.52 MB | 11.56 / 11.52 MB |
| Log rows / state rows | 4,096 / 1 | 4,096 / 1 |
| Main SQLite file | 1,470,464 bytes | 1,470,464 bytes |
| WAL file at completion | 300,792 bytes | 309,032 bytes |
| Process disk writes | 134,926,336 bytes | 135,036,928 bytes |
| Writes after stop / recorded errors | 0 / 0 | 0 / 0 |
| Attempts during one locked sample | **2** | **1** |
| Blocking time during that lock | **204.34 ms** | **103.41 ms** |

Only the failure path changed. Differences in normal sampling times reflect
run-to-run conditions on a shared server and are **not attributed to the fix**.
The normal path was already sufficiently cheap at its 30-second cadence.
Retained heap checkpoints remain flat rather than growing with sample count.

Raw measurements: [baseline](monitor-baseline.json), [final](monitor-final.json),
[contention before](contention-before.json), [contention after](contention-after.json).
