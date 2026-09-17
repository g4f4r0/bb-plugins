Dusk performance investigation — 2026-09-17

The changes are deployed under plugin ID `dusk` from `/home/g4f4r0/projects/bb-plugins/bb-plugin-dusk`. Only this package changed. This is a substantial improvement, **not a claim of locked 60fps or completion of every requested edge case**.

Measurements use Chromium 153 headless on the shared server, Playwright 1.63, a 1440×960 desktop viewport or 360×960 touch viewport, and the live BB frontend/plugin bundle. The sidebar bootstrap is intercepted with 0/500/1000 synthetic threads. Mutating requests are intercepted; no fixture threads are persisted. Frame intervals cover eight toggle/collapse cycles, including the triggering clicks. Trace event totals also include initial load. CPU samples are approximate, and these results do not establish performance on the user's physical GPU or mobile device.


| Workload                                   | Before                                  | After                                                          | Evidence                                                                                                             |
| ------------------------------------------ | --------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 500 desktop threads, mounted status rows   | 500                                     | 19 initially; viewport + overscan + retained targets afterward | `artifacts/baseline-500.json`, `artifacts/final-v2-500.json`                                                         |
| 500 desktop threads, p95 frame interval    | 183.3 ms                                | 16.8 ms                                                        | Same files and corresponding `.trace.json` files                                                                     |
| 500 desktop threads, longest sampled frame | 433.3 ms                                | 66.7 ms                                                        | Same files; outliers remain                                                                                          |
| Layout objects in desktop trace            | 8,761                                   | At most 698                                                    | Same traces, `Layout.beginData.totalObjects`                                                                         |
| 1,000 desktop threads                      | No comparable initial baseline captured | 19 initial rows, p95 33.3 ms, max 100 ms                       | `artifacts/final-v2-1000.json`                                                                                       |
| Empty sidebar                              | —                                       | 0 rows, p95 16.7 ms                                            | `artifacts/final-0.json`                                                                                             |
| Ambient hot-loop CPU samples               | 392.6 ms / 95 uploads                   | 168.3 ms / 98 uploads                                          | `artifacts/render-baseline.cpuprofile`, `artifacts/render-final.cpuprofile`                                          |
| Photo per-frame `drawImage` CPU samples    | 1,453 ms                                | No per-frame copy, absent from the final hot functions         | `artifacts/photo-baseline.cpuprofile`, `artifacts/photo-final.cpuprofile`                                            |
| Rapid traversal of 1,000 rows, detail RPCs | 1,000                                   | 0                                                              | `artifacts/hover-baseline-1000.json`, `artifacts/hover-final-1000.json`                                              |
| Native row following a removed row         | Pin button remounted                    | Pin DOM identity retained                                      | `artifacts/portals-baseline.trace.json`, `artifacts/portals-final.trace.json`; `tests/native-portals.mjs` assertions |
| Mobile shelf, 500 threads                  | p95 300 ms before recents containment   | p95 66.6 ms after deployed containment                         | `artifacts/mobile-final-500.json`, `artifacts/mobile-deployed-500.json`                                              |


Confirmed issues and resulting behavior:

- The status list mounted every row and its interaction components. `lib/status-list.tsx:482` now flattens rows and headings into stable items; `lib/virtual-status-list.tsx:7` uses fixed-height virtualization. The first nine shortcut targets, active thread, and most recent interaction target remain mounted. Arrow/Home/End navigation crosses virtual ranges. Menus retain their trigger when scrolled offscreen. Interaction components mount on first hover/focus rather than for every newly visible row (`lib/status-list.tsx:248`).
- Header synchronization synchronously read geometry after broad mutation callbacks. Dusk layout callbacks appear in `render-baseline.trace.json`; the mutation fixture independently checks that 1,000 unrelated insertions now cause zero header geometry reads. `lib/homepage-header.ts:28` writes only changed values, uses transforms for position, and filters/coalesces observer callbacks. Geometry reads remain necessary to follow host-owned transitions; forced layout has not been eliminated globally.
- Ambient rendering was the hottest Dusk function in the CPU profile. `lib/ambient.ts:18` precomputes horizontal interpolation and packed color values and interpolates each field row once. Resolution, phase continuity, and dither structure are retained; quantization can change an unlit channel by one unit. Reduced motion completes an in-progress fade instead of leaving an intermediate blend.
- Photo rendering synchronously copied WebGL output to a 2D canvas on each draw. `lib/photo.ts:82` now presents a separate WebGL canvas directly. `lib/fade.ts:3` selects that surface for snapshots. Copies occur at renderer handoff, with a preserved drawing buffer for reliable snapshots; this trades some GPU memory for removal of recurring readbacks. A temporary opacity animation handles photo crossfades and is canceled/removed on disposal. Context loss restores the static image.
- The native portal key included its array index and performed `indexOf` for each row. `lib/sidebar.tsx:9` assigns a stable key to each mount, preserving pin-button identity when earlier DOM rows disappear.
- Hovering immediately fetched details and retained successful promises without a size bound. `lib/status-list.tsx:203` waits for the hover card to open; `lib/promise-cache.ts:2` bounds pending and successful entries to 128, lazily expires results, and prevents an old rejected request from evicting a newer result. The bounded cache owns no timers.
- A newly reproduced mobile bottleneck was the host's large homepage-recents DOM. The final rules in `app.css` use `content-visibility: auto` and an intrinsic row size, preserving native rows, focus and find-in-page while skipping offscreen layout/paint.

Disposition of the other hypotheses:


| Hypothesis                                  | Finding                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long `:is():has()` selectors                | A broad ablation suggests a contribution: deleting 38 Dusk `:has()` rules only in the browser experiment reduced mobile p95 from 66.6 to 33.3 ms (`artifacts/mobile-no-has-500.json`). That experiment changes styling/layout as well as matching cost, removes required treatments, and is **not deployed**. Attribution to individual rules and a semantics-preserving rewrite remain unfinished. |
| `mask-image` repaints                       | Paint appears in the traces, but an isolated mask-specific regression was not established. Masks remain.                                                                                                                                                                                                                                                                                            |
| `coarse-pointer-sizing.ts` `transition-all` | The three reported exports have no consumers in this package. No live layout animation was reproduced from them; unchanged. No layout animation was added.                                                                                                                                                                                                                                          |
| Remote Geist import                         | The Google Fonts CSS request is present in the baseline trace. FOUT/CodeMirror remeasurement was not isolated; unchanged.                                                                                                                                                                                                                                                                           |
| 30-second clock updates                     | Virtualization bounds mounted row updates, but the clock and whole-list family calculation remain. Hidden-tab wallpaper animation is suspended; hidden-tab clock work was not independently optimized.                                                                                                                                                                                              |


Verification:

- `npm ci --include=dev`: passed, zero audit vulnerabilities. npm reports the existing native `better-sqlite3` install script as not approved; these checks did not require that binary.
- `npm run typecheck`: passed.
- `npm test`: 9 tests passed, including status grouping/snooze/pin rules, pending/successful cache bounds, retry, and stale-rejection races.
- `npm run test:render`: passed. Covers unrelated mutation isolation, observer/frame disposal, hidden-tab suspension, direct photo rendering, context-loss fallback, and layer cleanup.
- `npm run test:homepage`: passed. Updated the obsolete `.dusk-customize`/centered-composer test to the current Edit background UI; tests ambient/reduced motion, palette changes, upload/removal, GPU presentation, editor identity/draft preservation, refresh, offline background fallback, and 360px bounds.
- Live sidebar regressions passed with 0, 500, and 1,000 threads: section toggles, far-end keyboard navigation, an open menu retained through scrolling, reduced motion, theme changes, and responsive resizing. The 360px touch shelf was also exercised with 500 threads.
- `tests/native-portals.mjs` passed the retained pin-node identity check against the live bundle.
- `tests/frame-integrity.mjs` passed: 39 sampled ready frames, zero blank frames during rapid toggling, continuous resizing and a concurrent theme change.
- `bb plugin build bb-plugin-dusk`, `bb plugin reload dusk`, and `bb plugin list` passed. Dusk, Browse, Beacon, Sidetree, Reserve and MCPs show `running` from this repository. Plugin ID remains `dusk`.

Limits and remaining work:

Locked 60fps is **not achieved across the requested matrix**: desktop 1,000-thread and mobile 500-thread runs retain slow frames. The synthetic rapid-hover/scroll workload still has substantial style work even though it no longer floods RPC. The selector experiment suggests further Dusk work is possible; the remaining cost cannot all be attributed to BB core. Native DnD/drop-preview behavior and real out-of-order pin/snooze RPC responses were not fully verified. Offline cache failures and background fallback were checked, but that is not equivalent to end-to-end validation of every offline action. Pixel checks detect blank wallpaper frames, not every possible visual flicker or font swap.

Reproduce with a compatible local Chromium executable (set `DUSK_BROWSER`; provide its shared-library path through `LD_LIBRARY_PATH` where required):

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run test:render
npm run test:homepage
DUSK_LABEL=repeat DUSK_THREADS=500 npm run test:sidebar
DUSK_LABEL=repeat DUSK_THREADS=1000 npm run test:sidebar
DUSK_LABEL=empty DUSK_THREADS=0 npm run test:sidebar
DUSK_LABEL=mobile DUSK_MOBILE=1 DUSK_THREADS=500 npm run test:sidebar
DUSK_LABEL=hover DUSK_HOVER=1 DUSK_THREADS=1000 npm run test:sidebar
DUSK_EXPECT_FIXED=1 node tests/native-portals.mjs
node tests/frame-integrity.mjs
DUSK_LABEL=ambient node tests/render-performance.mjs
DUSK_LABEL=photo DUSK_PHOTO=1 node tests/render-performance.mjs
# Diagnostic only: removes styling in an isolated browser, never in source.
DUSK_LABEL=no-has DUSK_NO_HAS=1 DUSK_MOBILE=1 npm run test:sidebar
```

Raw trace/profile/screenshot artifacts stay in this permanent package's ignored `validation/artifacts/` directory. Source, tests, this report and `package-lock.json` are tracked in Git. The baseline refers to the initial live bundle; later intermediate files are intentionally retained rather than relabeled as final.