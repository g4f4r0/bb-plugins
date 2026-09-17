# Beacon performance verification — 2026-09-17

Implementation: `cc9560a`. Only `bb-plugin-beacon` changed. Plugin ID remains `beacon`.
The first command, `bb plugin source beacon --json`, resolved to
`path:/home/g4f4r0/projects/bb-plugins/bb-plugin-beacon`.

## Findings and changes

| Area | Before | After / evidence |
| --- | --- | --- |
| Disclosure lifecycle | Hiding cleared data; rendering also required `active`. BB actually unmounts the disclosure on close. Each reopening could start a fresh RPC. | One app-level snapshot and in-flight request survive remounts. No thread keys or cache timers. Mounted pollers preserve cadence/backoff across visibility changes. |
| Cold/loading/error UI | Spinner-to-value changes; skeleton replay; errors without data retained loading placeholders. | Static dash for counters awaiting a baseline, static initial placeholders, explicit unavailable state on failure, last-sample time for cached data. CPU/uptime placeholder sizes adjusted; variable core counts and optional rows still prevent exact first-load size prediction. |
| Meters | Width/height mutations on every reading. | Fixed geometry with `scaleX`/`scaleY`, 300ms transform transitions, reduced-motion transition override. No forced layout reads added. This is not a measured FPS claim. |
| Interval changes | Existing server cache could expire on the previous short interval after changing to a longer cadence. | Settings changes re-arm its one-shot expiry. Regression test covers 2s → 30s. |
| Notification lifecycle | Visibility/reconnect reconciliation was serial, generation-checked and cleaned up; page lifecycle events were missing. | Added pagehide/pageshow guards and listener disposal; hidden realtime callbacks also respect the pagehide guard. |
| Narrow display | Beacon imposed a 256px minimum width. | Removed the minimum; verified at a 390px viewport with no horizontal overflow and an existing host scroll container. |

## Findings that did not warrant changes

- History remains capped at 72 in storage and the RPC schema. Existing backend tests perform 80 samples and verify the cap, idle reset, and cold CPU/network baselines.
- Chart indices represent 36 fixed slots; core indices represent stable core positions. These are appropriate keys. Processes already use PID keys.
- Demand sampling remains shared and serial, with no recurring collection timer. Its idle expiry is a single cleanup timer, not a polling loop.
- Dashboard settings support 2–60 seconds. A configured 1s interval is rejected; defensive frontend polling clamps it to 2s. This bound was preserved.
- Skeleton/spinner reduced-motion handling already existed. Removing their animation avoids continuous loading animation altogether.

## Checks performed

- `npm ci --include=dev`: passed, 0 reported vulnerabilities. Existing tracked `package-lock.json` retained unchanged; no new dependencies.
- `npm run typecheck`: passed.
- `npm test`: 65 passed, 0 failed. New cases cover remount request sharing and offline backoff, rapid hide/show, changed intervals, and expiry. Existing cases cover slow requests, disposal, errors, bounds, and simulated long idle periods. The snapshot-source test advances 10 minutes without work; hidden-poller tests advance one hour.
- `git diff --check`: passed.
- Committed implementation, then `bb plugin build bb-plugin-beacon` and `bb plugin reload beacon`: passed.
- `bb plugin list`: Beacon running from the permanent source; Browse, Dusk, MCPs, Reserve and Sidetree also running from their permanent repo directories. No other plugin was changed or reloaded for this work.

## Live browser evidence

Managed Fortress against the running BB server; counters wrap only Beacon RPC requests in the test browser.

| Scenario | Observed result |
| --- | --- |
| Before: 10 close/open cycles, 300ms open / 150ms closed | 9 metrics RPCs in about 5 seconds. Separate short-cycle inspection observed loading placeholders on all 10 opens. |
| After: same 10 cycles | 0 additional metrics RPCs within the cache interval; 0 placeholder observations after the first snapshot. |
| Actual disclosure closed for 12 seconds | 0 metrics requests; reopening made 1 request. |
| Synthetic document visibility hidden for 11 seconds | 0 Beacon RPCs; showing made 1 metrics request and 1 notification reconciliation. |
| 20 rapid synthetic hide/show cycles | 0 metrics RPCs; 2 serial notification reconciliations (in-flight plus coalesced repeat). |
| Cold metrics transport forced offline, 5 rapid reopen cycles | 1 network attempt; explicit error/unavailable UI. Restoring transport recovered after backoff. |
| Metrics response delayed 8 seconds, 10 close/open cycles | 1 request total, maximum 1 in flight; data present after completion. |
| 390px viewport | No Beacon horizontal overflow. 641px content remained accessible through BB's 320px scrolling container. |
| Theme class switched and restored | Text changed from `rgb(55, 53, 47)` to `rgb(199, 199, 197)`. Transform transitions and Beacon-scoped reduced-motion rules present in computed styles/CSSOM. |

## Boundaries

The existing **opt-in background pressure monitor is enabled on this server** and remains enabled. It deliberately samples CPU/memory every 30 seconds even with all UI hidden. Visibility gating applies to dashboard polling and notification reconciliation; this deployment does not claim zero server work when that separate feature is enabled.

Long-hidden tests use a simulated clock, not a ten-minute wall-clock browser wait. Visibility tests use synthetic document events; actual disclosure close/open was also exercised. Reduced motion was checked in the emitted stylesheet, not with OS preference emulation. The SDK frontend RPC API exposes no abort signal: an already-started request may finish after hiding, but no new polling is scheduled while hidden and stale component updates are discarded. A permanently unresolved RPC remains single-flight rather than spawning overlapping retries.
