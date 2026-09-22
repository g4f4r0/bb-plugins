# Wayfinder implementation record

## Step 1 — foundation and capability spike (2026-09-21)

Status: complete as a checked, committed foundation only. `server.ts` and
`host.ts` are labeled non-production stubs. Wayfinder was not installed,
reloaded, enabled, or exercised against a live browser/native application.

### Repository and SDK facts

- Permanent source: `/home/g4f4r0/projects/bb-plugins/bb-plugin-wayfinder`.
- Git remote: `https://github.com/g4f4r0/bb-plugins.git`.
- `bb status --json`: project `proj_zy2t7tiss9`, environment
  `env_75h5p7m4zb`, connected host `host_wzbe6egp4i` (`server`).
- `bb --version`: `0.43.1`.
- Current Plugin SDK declaration/package: `@get-bb/plugin-sdk@0.4.87`.
- `bb plugin source wayfinder --json`: HTTP 404, confirming Wayfinder is not
  installed.
- Manifest ID remains `wayfinder`; `.bb/plugins.json` now lists the source for
  future explicit installs.

Current SDK contracts used rather than inferred:

- Server factory: `BbPluginApi`; load-safe registration and LIFO disposal.
- Host entry: `experimental_defineHostEntry`, schema RPC, explicit `hostId`,
  per-call and lifecycle abort signals, lazy reusable worker, 8 MiB JSON call
  ceiling, five-minute idle eviction, and private ephemeral signals.
- Browser control: `bb.sdk.experimental_desktopBrowsers` exposes
  `listInstances`, `listTabs`, `createTab`, `acquireControl`, `openConnection`,
  `releaseControl`, `revealTab`, `closeTab`, `captureTab`, and `subscribe`.
  Connection endpoints are host-local and must never be shared publicly.
- UI: a future `app.tsx` should register a `navPanel` named Computer. Inline
  artifact cards should use `messageDirective`; its attributes are explicitly
  untrusted and include authenticated message/thread context. No private DOM
  patch is needed. `bb.app` is intentionally absent from the foundation
  manifest so a nonexistent UI cannot be built or advertised.
- HTTP plugin routes are exact-match. Artifact IDs therefore belong in
  authenticated query/input data on the fixed route constants in
  `src/contracts/artifact.ts`, not in invented wildcard paths.

### Host capability probe

Read-only commands only; no session acquisition, live application input,
daemon start, browser launch, cookie import, privileged install, or exposed
port occurred.

| Capability | Observed result | Release implication |
| --- | --- | --- |
| Platform | Debian 13 (`trixie`), Linux x86_64, Node `v24.21.0`, npm `11.19.0` | Supported foundation toolchain. Production target remains Node 22+ because BB host entries run on Node 22. |
| Fortress/CDP | `bb browser instances --host host_wzbe6egp4i --json` returned `{"instances":[]}`; no standalone `fortress`, Chromium, Chrome, or Playwright executable was found | Browser adapter can be implemented offline, but no real Fortress/CDP success may be claimed until BB exposes an instance and an exact thread-scoped lease is tested. |
| Cua | `/home/g4f4r0/.local/bin/cua-driver`, version `0.28.2`, native `x86_64-linux`; daemon not running | Direct runtime integration is available without reinstalling the removed BB plugin. Use embedded/direct runtime with a reviewed bounded capability manifest; do not use its broad kill/install/history tools. |
| Linux desktop | Cua doctor reports X11 `DISPLAY=:99`, no top-level windows, and unreachable AT-SPI bus; `atspi-2` pkg-config is absent | Native live fixture is setup-required. Installing/starting system accessibility components or an interactive session needs user consent/coordination. The synthetic accessibility fixture is not live proof. |
| OCR | `tesseract` absent | OCR is optional and blocked until an approved provider/runtime is chosen. Accessibility-first implementation can proceed. |
| Media | FFmpeg/ffprobe `7.1.5`; `libx264` is present; VAAPI/QSV/NVENC/Vulkan encoders are advertised | Software H.264 is available. Hardware encoders are only advertised, not functionally verified; Step 3 must probe and fall back. |
| Infisical/provider | Infisical CLI `0.43.132`; no `.infisical.json`; connected MCP search returned no Infisical tools; no project/environment/path was resolved | No secrets were read. TypeSafe/Jev is setup-required until the repository is linked or an authorized project is selected, then an explicit environment and narrow secret path are supplied. Never guess these values or create `.env`. |

Removed `browse`, `cua-driver`, and browser-automation BB plugins were not
installed. The existing Cua executable was probed directly as authorized.

### Pinned upstream review

- `awlevin/typesafe-computer-use@cc7b5066ae1a07b5e3182e8f87a9b5b6dfdcffc1`:
  local research files were re-read. Useful concepts are accessibility/OCR
  target fusion, bounded choices, changed-region reuse, and typed-field
  readback. Its implementation is Python/macOS and its README only sketches a
  Linux AT-SPI/OCR port, so it is not a native Linux proof or dependency.
- `Ying-Kai-Liao/jev-browser@578cff6e701a131733d03256078bb559a45ad188`:
  local source was re-read. It uses Playwright Chromium, grouped target
  choices, bounded outcomes, and repeated-action/no-progress stops. Fortress
  compatibility is unproven, so the package was not installed. Model
  completion remains advisory; deterministic checkpoints decide pass/fail.
- `browser-use/jev-ultrafast@1231850a0bf1a0c0341fe408ef1668dbbfdfac46`:
  pinned `agent.py`, `browser.py`, `model.py`, and `pyproject.toml` were read
  from upstream. Relevant patterns are an atomic DOM/action snapshot, stable
  node IDs, fingerprint/guard revalidation immediately before input,
  consume-once decisions, and logging action intent before post-action
  observation. It is Python 3.12 with `browser-harness`, not a dependency.

No upstream code was copied in this step. Preserve the MIT notices if later
implementation copies a substantial portion rather than independently applying
the design patterns.

### Shared contracts

All wire schemas use strict Zod objects, bounded arrays/strings/bytes, and
explicit discriminated unions. Unknown fields fail validation.

- `src/contracts/primitives.ts`: IDs, digests, timestamps, canonical origins,
  literal-private fixture distinction, traversal-free paths, rectangles.
- `src/contracts/media.ts`: capture limits, protected-interval suspension,
  media descriptors.
- `src/contracts/route.ts`: versioned route, host/thread/project/environment
  identity, distinct navigation/resource origins, app/window allowlists,
  fixture/output roots, action allowlist, required typed checkpoints, data
  references, capture policy, and hard limits.
- `src/contracts/run.ts`: lifecycle/terminal states, errors, cleanup outcome,
  checkpoint results where `unknown` is not pass, caller-scoped start input,
  scoped single-use user approvals, and Computer snapshot.
- `src/contracts/adapter.ts`: observed target IDs/generations, typed actions,
  intent/outcome journal shapes, normalized Jev distributions, and Effect
  interfaces `AutomationAdapter` and `DecisionProvider`. No model-facing
  selector, coordinate, JavaScript, shell command, absolute path, or raw
  protected value exists in an action.
- `src/contracts/artifact.ts`: private artifact records, sanitized immutable
  share records, unique selections, HTTPS external URL, fixed HTTP routes, and
  bounded 1 MiB range reads.
- `src/contracts/api.ts`: frontend/server RPC methods.
- `src/contracts/host.ts`: server/host RPC and invalidation signals.
- `src/contracts/index.ts`: shared public contract barrel.

Frontend/server RPC methods:

- `runs.start`, `runs.status`, `runs.cancel`
- `computer.snapshot`
- `artifacts.list`, `artifacts.createShare`, `artifacts.revokeShare`

Server/host methods:

- `capabilities.probe`
- `runs.start`, `runs.status`, `runs.cancel`
- `media.latest` (bounded optimized frame; no video base64)
- `artifacts.readRange` (inclusive range below 1 MiB)

Host signals carry invalidation IDs only: `runChanged`, `frameAvailable`, and
`artifactChanged`. Durable state must be re-read after reconnect.

### Fixtures and ownership

`fixtures/browser/index.html` is a local synthetic form with no network or
external side effect. `fixtures/desktop/accessibility.json` is a synthetic
native observation. Both pass contract tests; neither proves live provider
readiness.

`OWNERSHIP.md` is authoritative for the fanout:

- Engine owner: `worker/`, `src/core/`, `src/adapters/`, `src/policy/`,
  `src/fs/`, and matching `tests/engine`, `tests/adapters`, `tests/policy`,
  `tests/fs`.
- UI/media owner: `app.tsx`, `app.css`, `components/`, `src/media/`,
  `src/artifacts/`, and matching `tests/ui`, `tests/media`, `tests/artifacts`.
- Integration owner: `src/contracts/`, package/lockfiles, `server.ts`,
  `host.ts`, and this record. Parallel owners report dependency or contract
  needs instead of editing these files.

### Dependencies and checks

Runtime foundations are pinned in `package.json` and fully resolved in
`package-lock.json`: Effect `3.22.2`, Zod `4.3.6`, SDK `0.4.87`, and the
current UI/test dependencies required by the two downstream owners. Zod is
pinned to the SDK-tested baseline. SDK 0.4.87 is not compatible with enabling
TypeScript `exactOptionalPropertyTypes` on its Standard Schema declaration, so
that optional compiler flag is intentionally omitted; strict typechecking and
`noUncheckedIndexedAccess` remain enabled.

Actual commands/results:

- `npm install --include=dev`: first attempt failed safely on an underspecified
  `@testing-library/react` peer; corrected to `16.3.3`, then installed 264
  packages with 0 audit vulnerabilities. No force/legacy-peer override used.
- `bb plugin types .`: SDK stayed `0.4.87`; host-shim declaration ranges were
  synchronized.
- `bb plugin types --check .`: PASS — package SDK `0.4.87` matches host SDK
  `0.4.87`.
- `npm run check`: PASS — `tsc --noEmit`; Vitest 4 files / 14 tests; BB build
  emitted server and host bundles/metadata only.
- In-memory `better-sqlite3` smoke query: PASS (`select 1` returned `1`).
- Filtered `bb plugin list --json`: none of `wayfinder`, `browse`,
  `cua-driver`, or `browser-automation` is installed.
- No install, reload, enable, live UI check, or provider transaction was run.

## Step 4 — bounded browser slice (2026-09-21)

Status: implemented and checked offline plus against the local Fortress fixture. This is not production-ready: provider scope and remote Computer UI checks remain blocked.

Checks:

- `bb plugin types --check .`: PASS (`@get-bb/plugin-sdk` 0.4.87).
- `npm run typecheck`: PASS; focused and full Vitest checks pass after the lifecycle/provider changes; BB build is still required before reload.
- Live deterministic fixture: PASS with Fortress v151.0.7908.0 using a fresh owned temporary profile and loopback CDP. The synthetic form reached `/done`, status was `Local report ready for Synthetic fixture`, and `Page.captureScreenshot` returned 13,092 bytes. Browser process and profile were stopped and removed. This is an independent fixture/CDP check, not a Jev run or external-site result.
- Permanent install: PASS — `wayfinder` is running from `path:/home/g4f4r0/projects/bb-plugins/bb-plugin-wayfinder`. Browse, Cua Driver, and Browser Automation remain uninstalled.

The host now acquires the single controller before launching Fortress, retains it through capture and cleanup, uses an ephemeral loopback fixture server and plugin-owned artifact storage, waits for process exit, and reports incomplete cleanup. Provider selection is route-configured (`fixture`, `jev`, or `openrouter`) with model and endpoint selection; credentials are read only from process injection boundaries (`WAYFINDER_*_API_KEY`) and missing Infisical scope remains setup-required. OpenRouter responses are strict choice IDs without fabricated confidence distributions. `media.latest` captures changing active-run frames and labels post-run evidence disconnected rather than live.

Focused live regression: `tests/host.test.ts` now runs the real Fortress fixture through the host harness and asserts `passed`, a `done_url` checkpoint, retained screenshot bytes, and an artifact range read. Observed live result: Fortress v151.0.7908.0, `/done` checkpoint passed, PNG artifact retained and served (17,628-byte base64 response; 13,092-byte PNG in the prior independent fixture run), cleanup completed, and the temporary profile was removed.

Blockers: no verified Infisical project/environment/path exists for this Wayfinder run, so Jev/OpenRouter invocation and any production readiness claim remain blocked. Native accessibility/OCR, remote Computer UI, and online sharing remain deferred. No CDP endpoint is exposed.

## Host portability update (2026-09-22)

Wayfinder now defaults execution to the trusted thread environment host. Routes may explicitly set `hostSelection: "any"`; only browser-only routes are portable. Desktop, filesystem, and mixed routes remain pinned to the thread host so local source trees, SDKs such as Xcode, applications, and permissions are not silently moved to another machine. Portable candidate order is thread host, configured fallback, then other connected hosts; every candidate must report both browser and selected-provider readiness.

The settings host list now reports BB connection state plus probed OS, architecture, browser readiness, and provider readiness. Host runtime data uses the SDK-provided per-host plugin data directory instead of the source checkout. Fortress discovery is platform-neutral: explicit environment override, PATH, standard macOS app locations, then migration compatibility with an older Browse installation. Missing platform binaries produce setup-required rather than a hard-coded Linux path.

Verification: `npm run typecheck`, all 24 Vitest files / 151 tests, and `npm run build` pass. Tests cover default thread affinity, explicit portable fallback, non-portable pinning, host ordering, platform status, real Fortress fixture execution, private artifacts, and cleanup.

Remaining public-release constraint: provider credentials still follow the repository's mandatory Infisical policy. A host-local credential backend cannot be shipped while that policy requires Infisical for every secret.

## Computer viewer controls update (2026-09-22)

Computer now follows the retained Browse viewer pattern: an active browser shows a pulsing viewport skeleton until its first frame, connection state floats at bottom-left, and the execution-machine name floats at bottom-right. Hovering or focusing an agent-controlled live viewport offers **Take control**. Human clicks, scrolling, typing/pasting, and keys are sent through bounded RPC to the run's existing loopback CDP adapter; no CDP endpoint is exposed.

A host-side control gate waits for the current atomic agent browser operation before granting one viewer the lease. Agent operations pause while the human owns it and resume when the viewer releases control. The viewer releases automatically when the browser window loses focus, the document is hidden, the Computer tab unmounts, or the one-minute lease expires. Multiple viewers remain read-only except for the single lease holder.

Verification: `npm run typecheck`, 25 Vitest files / 158 tests, and the production build pass. Tests cover atomic handoff, competing viewers, lease expiry, CDP input ownership, UI takeover/release, and the existing Fortress fixture path.

## Whole-computer viewer/runtime update (2026-09-22)

Computer is a private whole-desktop viewport, not a browser screenshot. Its host starts a Wayfinder-owned Cua Driver daemon with a reviewed bounded manifest covering only primary-display capture and human handoff input. The daemon captures the actual desktop only while the Computer panel is visible; hidden tabs stop preview requests and becoming visible refreshes immediately. Capture stays local/private and oversized frames are downscaled before crossing the host RPC boundary.

Browser-only agent runs may still use BB's isolated built-in browser on macOS/Windows, while Linux/server execution keeps Fortress. Those are execution runtimes inside the computer—not substitutes for its desktop viewport. Human takeover is dispatched in the same desktop coordinate space shown in Computer, while the existing control gate pauses the agent at an atomic operation boundary. If Cua Driver or OS screen-recording permission is missing, Computer reports desktop setup required instead of presenting a browser-only fallback or fabricated idle screen.

No responsive, annotation, or duplicate browser-management layer was added.

### Deferred follow-up

A real BB browser lease, Jev credential resolution through Infisical, native accessibility, and verified HTTPS sharing are prerequisites for the remaining live-provider gates. No speculative fallback or external mutation was added.
