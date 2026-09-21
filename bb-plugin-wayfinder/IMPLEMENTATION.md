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

### Required downstream integration work

- Engine: implement the queue/lease/journal and adapters behind the published
  contracts. Acquire a BB desktop-browser lease through the SDK; keep the CDP
  endpoint host-local. Bind Cua to the exact allowed app/window generation and
  narrow its capability manifest. Resolve Jev credentials only through a
  verified Infisical project/environment/path and process injection.
- UI/media: add `app.tsx`/`app.css` and request the integration owner add
  `bb.app` after tests exist. Register the Computer nav panel and a validated
  artifact message directive. Keep live view private/read-only, cache one feed
  per run, drop stale frames, and use authenticated fixed routes for
  Copy/Download/Share.
- Integration: replace both labeled stubs, register RPC/HTTP/realtime/lifecycle,
  reconcile orphaned runs, add authenticated range/no-store/no-referrer
  handling, and only then build/install from this permanent source.
