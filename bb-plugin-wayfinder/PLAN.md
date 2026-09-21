# Wayfinder: implementation and release plan

Status: implementation authorized. This document supersedes the earlier Python/browser-only proposal. No feature is complete until its tests and live checks pass. Favor a small working vertical slice over speculative frameworks.

## Product

Wayfinder tests browser flows, desktop apps, and their filesystem outputs on one shared server computer. A BB agent supplies a goal, typed checkpoints, and allowed actions. A local worker executes routine steps without returning to the main model after every click. Deterministic assertions establish success; Jev's completion score does not.

Required user experience:

- A **Computer** sidebar tab shows the shared computer, active thread/run, queue, and private live app/browser view.
- Screenshots, clips, reports, and trails appear inline in the originating thread with **Copy**, **Download**, and **Share** controls. Copy image where supported, otherwise offer copy link with a clear label.
- Selected artifacts can be shared online through an explicitly approved, expiring and revocable export.
- One computer for all threads, not a VM per thread. One active controller initially; multiple authorized read-only viewers. Browser profiles, artifact ownership, and filesystem scopes remain isolated.

## Chosen stack

| Layer | Choice |
| --- | --- |
| BB integration | TypeScript and the installed BB Plugin SDK; stable plugin ID `wayfinder` |
| UI | React and BB frontend SDK slots/components |
| Worker | TypeScript on Node, supervised outside bb-server; Effect for scoped resources, cancellation, bounded queues, and typed failures where useful |
| Browser | Fortress, direct CDP; a narrow Playwright-over-CDP adapter is acceptable if the compatibility spike justifies it |
| Decisions | Jev through TypeSafe; bounded operation/target choices over structured observations |
| Desktop | Direct Cua Driver runtime integration, not the removed BB Cua plugin |
| Desktop perception | Accessibility first, cropped/incremental OCR as needed; explicit visual-model escalation only when structured targets are insufficient |
| Filesystem | Code-owned scoped reads/writes and output verification; no arbitrary shell tool exposed through model actions |
| State | BB plugin storage for metadata, private host files for bounded durable artifacts |
| Secrets | Infisical, verified project/environment/folder scope and process injection |
| Media | Bounded live frames, optimized images, H.264/yuv420p MP4 with byte-range playback; hardware encoder when supported |

Python is not a required Wayfinder sidecar. A native dependency may have its own runtime, but do not port the reference Python app wholesale. Bun is deferred unless a measured benefit warrants an additional runtime. Effect is a library, not a runtime or excuse to build a framework.

Read the repository README and installed SDK declarations before implementation. Resolve `bb plugin source wayfinder --json` before editing an installed copy; initially it is not installed. Build and install only from `/home/g4f4r0/projects/bb-plugins/bb-plugin-wayfinder`. Preserve the original Browse source as reference but do not install it. Cua Driver, Browse, and BB Browser Automation BB plugins remain uninstalled. Direct Cua runtime integration is now explicitly in scope; installing a separate BB computer-use plugin is not.

## Reference code to audit

MIT-licensed references, pinned for inspection:

- `awlevin/typesafe-computer-use` at `cc7b5066ae1a07b5e3182e8f87a9b5b6dfdcffc1`: accessibility/OCR target fusion, mutually exclusive choices, changed-region OCR, no-progress detection, per-phase timing. Its native implementation is Python/macOS, not a verified Linux backend.
- `Ying-Kai-Liao/jev-browser` at `578cff6e701a131733d03256078bb559a45ad188`: JavaScript local loop, page diffs, grouped target selection, bounded statuses. Uses Playwright Chromium by default; Fortress support is not established. Do not inherit model-only irreversible-action gating or pass model checks off as deterministic verification.
- `browser-use/jev-ultrafast` at `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`: atomic DOM extraction and low-latency decision/action loop; treat this older pin as requiring verification.

Research files for the first two are under `/home/g4f4r0/.bb/thread-storage/thr_ev9k2b6rf7/research`. Re-read upstream files relevant to any adaptation; preserve license/attribution. Upstream benchmarks are author-reported, not Wayfinder results. Pin actual dependencies and commit lockfiles. Do not execute upstream installation scripts blindly.

## Architecture and ownership

BB backend -> typed start/status/cancel/approval API -> host supervisor -> local TypeScript worker.

Worker adapters:

1. Browser: Fortress/CDP -> compact DOM -> Jev -> validated browser action.
2. Desktop: Cua -> app/window accessibility + optional OCR -> Jev -> validated native action.
3. Files: scoped operations -> deterministic filesystem assertions.

All adapters share policy, run state, a single host control lease, evidence capture, and checkpoint evaluation. Browser-to-desktop transitions must transfer the same lease and bind the intended app/window, not silently control whatever has focus. Only one active controller across threads in v1. Queue fairly; show owner and wait state. External human activity can invalidate an observation: pause/reobserve instead of blindly sending input.

Use code-owned identities: run, host, thread, project, environment, document/frame or app/window generation, snapshot, and observed target. Revalidate immediately before input. Never turn a model answer into an arbitrary selector, coordinate, executable JavaScript, filesystem path, or shell command. Coordinates derived from a validated observed target are permitted for native input; reject stale geometry.

The browser, native runtime, capture, and filesystem operations run on the selected host. Start with this server only. Reject a mismatched host rather than executing on the wrong computer. Future remote-host dispatch uses public SDK host RPC, not public CDP or worker sockets.

## Routes, lifecycle, and safety

Use one versioned strict schema for goals, allowed apps/origins/paths/actions, typed checkpoints, data references, capture policy, and limits. Compile natural-language assertions outside the action loop and show the resolved predicates. Reject unknown fields, unsupported assertions, and empty required-checkpoint sets.

Checkpoints distinguish historical step results from final state. Initial predicates cover URL, visible text/control state, field value, structured row/cart values, selected network outcomes, and scoped filesystem existence/content/hash. Unknown is never pass. Trusted verifier code is separately tested; never execute verifier code supplied by a model.

Run states: queued, running, awaiting_confirmation, verifying; terminal passed, failed, blocked, cancelled, timed_out, interrupted. Cleanup has its own outcome.

- Start returns promptly with a run ID. Status polls do not drive actions.
- Deduplicate starts by caller-scoped idempotency key and route hash.
- Journal intent before dispatch and outcome after. A crash between them means uncertain mutation, never automatic replay.
- Bound runtime, decisions, tokens/spend, no-progress loops, request retries, queue length, artifacts, and capture buffers.
- Lease/heartbeat expiry, cancellation, process death, thread/environment disposal, reload, disable, and uninstall close only owned resources. Startup reconciles orphaned runs. Report incomplete cleanup.
- Use BB lifecycle and host-worker leases correctly; don't depend solely on a dispose hook or a long RPC staying alive.
- Approval requires authenticated user provenance, scoped to one action, target, state, route/policy hash, and expiry; single-use and revalidated. An agent boolean is not user consent.
- V1 stops before purchases, payments, external messages, destructive deletion, permission/account changes, and other consequential actions. Testing uses local fixtures, synthetic data, and approved read-only/live-cart scope.
- Define exact navigation versus resource origins. Guard redirects, popups, frames, downloads, workers, and non-HTTP URLs; private/metadata addresses denied except explicit fixtures. CDP interception alone is not proof against all website side effects or DNS rebinding.
- Native actions enforce app/window allowlists and visible target identity. No arbitrary desktop wandering, CAPTCHA bypass, or access-control circumvention.
- Filesystem operations stay within explicit run roots, handle symlinks/path traversal safely, and distinguish fixtures from outputs. Do not expose arbitrary home-directory access; destructive fixture cleanup affects only owned paths.
- Unsupported native APIs, missing OCR, ambiguous targets, low confidence, or unavailable providers return a bounded actionable blocked result. Never pretend a fallback succeeded.

## Secrets and privacy

Resolve provider and application credentials through Infisical with verified project, explicit environment, and narrow path. No secret values in prompts, BB settings, shell arguments, logs, URLs, traces, screenshots, or recordings. Do not use browser login to Infisical. If auth/scope is unavailable, name the prerequisite, not a guessed secret location.

Use synthetic data initially. Never send secret field values to Jev or a writer. Resolve a field first, then inject through a separate protected path. Password masks are insufficient; suspend all model-visible capture/live preview/recording through protected intervals until a verified safe state. Sanitize before serializing, hashing, or exporting. Queries, fragments, bodies, headers, console output, and OCR may contain sensitive data; retain only approved fields. Authenticated-profile reuse remains deferred until leak tests pass.

## Computer tab and media

Required Computer tab: host readiness, active owner, run queue, selected run, action/checkpoint, elapsed time, cancel, connection state, frame age, and artifact links. The selected historical run must not be confused with the current host owner. Live viewing is read-only; no unreviewed keyboard/mouse takeover feature.

Capture only the selected browser viewport/app window, not unrelated desktop windows. Reconnect rechecks authorization and run ownership. Explicit paused/redacted/disconnected states replace stale images. Closing a viewer stops its subscription, not the run. Never publicly share the live computer view.

Performance rules:

- Reuse worker/provider connections; never reuse another run's cookies or profile.
- Prefer event-driven settling, compact snapshots/diffs, grouped target selection, and accessibility over OCR. No forced sleep/model round trip per click.
- Crop OCR and reuse unchanged regions, invalidating on app/window/geometry changes. Bound cache lifetime and size.
- Capture one live feed per run and fan out to authorized viewers. Drop stale frames; never block execution on a slow client.
- Adapt preview resolution/rate to visibility and network load. Stop preview-only capture with no viewers.
- Images use compressed thumbnails and separately accessible full-resolution evidence; preserve text readability. Choose WebP/JPEG/PNG by measured size and fidelity, not a single lossy format for everything.
- Video uses bounded independent capture and asynchronous encoding/export. Prefer hardware H.264 when supported; otherwise bounded software encoding. MP4 fast-start, yuv420p, timestamped events, short failure clips, and range requests. Never base64-embed full videos.
- Preserve original diagnostic timestamps. Any trimmed/sped-up presentation copy is separately labeled; do not use it for timing claims.
- Test 1280x720 customer exports, mobile playback, aspect ratio, cursor visibility, and redaction gaps. Synthetic wallpaper margins are optional export styling, not whole-desktop capture.

Inline thread cards must provide preview, filename/type/size, and accessible Copy/Download/Share icons with tooltips and error feedback. Clipboard API failure has a fallback. Use supported BB message/artifact rendering APIs, not private DOM patches; document any SDK limitation honestly.

## Online artifacts

Tie artifacts to originating thread/run and persist them independently of temporary profiles. Internal links use authenticated remote BB/plugin routes. Sharing is an explicit selection/export action, never automatic publication of a thread transcript or arbitrary storage directory.

Create sanitized immutable exports with a file manifest and approved audience. External read-only links expire, are revocable and unguessable; treat credentials as secrets and use Infisical-backed signing if required. Do not invent new secret storage. Default external expiry is 7 days; default local artifact retention is 30 days, configurable downwards and bounded by a documented disk quota. External sharing stays disabled until signing/auth prerequisites are verified.

Use safe generated paths, MIME validation, per-run access checks, private/no-store and no-referrer behavior, bounded downloads/range responses, and expiry/deletion of export copies. HTML must be sandboxed or downloaded, never execute in BB's origin. Revocation stops future requests but cannot recall downloaded copies. Never expose CDP, native driver ports, sockets, raw filesystem, or the live stream for artifact sharing.

## Ordered implementation steps

Each step records actual files, commands/tests, live evidence, and blockers in `IMPLEMENTATION.md`. Do not mark a step done solely because a mock passes.

### 1. Foundation and capability spike

Owner: GPT-5.6-Sol/high.

- Inspect host platform, installed Fortress/Cua/encoder/OCR availability and exact SDK contracts. No unapproved privileged/system installs.
- Scaffold the real Wayfinder package, pinned dependencies/lockfile, typecheck/test/build commands, shared strict contracts, adapter interfaces, and run/error types.
- Build local browser and desktop test fixtures as appropriate. Probe actual Fortress CDP and Cua readiness independently; record missing provider credentials without leaking values.
- Establish boundaries and files for independent implementation tasks; publish contracts before parallel edits.

Gate: package checks work, contracts are explicit, actual prerequisites are recorded. A missing native/model prerequisite does not prevent offline implementation, but blocks claims of live completion.

### 2. Execution engine and adapters

Owner: GPT-5.6-Sol/high, after step 1.

- Implement TypeScript worker, single-controller queue/lease, bounded local Jev loop, independent verification, cancellation, crash reconciliation, and policy.
- Implement Fortress/browser, Cua/native, and filesystem adapters against the shared interfaces. Keep SDK/server wiring outside these modules.
- Add local fixture and adversarial tests for stale targets, uncertain mutation, concurrent requests, spoofed approvals, path escape, unsupported states, and privacy.
- Prove at least one real browser fixture and one real native-app fixture if prerequisites allow; expose clear setup-required otherwise.

### 3. Computer UI and media/artifact components

Owner: Claude Opus 5/high, parallel with step 2 only on disjoint files.

- Implement Computer panel and client components against shared contracts.
- Implement bounded media capture/export and artifact services in their assigned directories, with inline cards and Copy/Download/Share behavior.
- Test slow clients, disconnects, image copy fallback, range playback, cross-thread isolation, safe rendering, export expiry/revocation, and quota enforcement.
- Do not edit worker/core, shared contracts, server entry, or package lock while the engine agent is active. Report integration needs instead.

### 4. BB integration

Owner: GPT-5.6-Sol/high, after both implementation branches return.

- Merge actual contracts and dependencies, implement backend/host lifecycle, tools/CLI, settings, HTTP/RPC, progress, and UI wiring.
- Resolve seams rather than leaving production mocks, placeholder buttons, or unimplemented adapters.
- Run typecheck, unit/fixture tests, and full BB build. Preserve removed-plugin state.
- Commit reviewed source and lockfiles, then build/install/reload from the permanent path only when checks pass and setup is safe. Verify actual plugin status and readiness.

### 5. Independent release review

Owner: Claude Opus 5/high, read-only review of the integrated result.

- Inspect security, correctness, cleanup, hot-path performance, UI contracts, and actual evidence.
- Run independent checks; distinguish offline coverage from real provider/browser/native/remote UI tests.
- Return concrete blockers with file locations and reproduction, not a generic approval.

### 6. Fix, recheck, and deliver

Owner: GPT-5.6-Sol/high, incorporating the review.

- Fix verified defects; add regression tests and rerun all affected checks.
- Verify remote Computer UI, inline artifact copy/download, approved sharing, expiry/revocation, browser route, native fixture, cancellation, and uninstall/reload cleanup where possible without disrupting unrelated work.
- Record exact versions, results, performance, unresolved prerequisites, and release readiness. Commit scoped work; no push unless requested.
- If a real prerequisite blocks release, leave a usable tested implementation and explicit setup-required state, not a false complete claim.

## Acceptance and measurements

Release gates:

- Real browser and native fixture results plus independent checkpoints; every pass has evidence.
- One controller across threads; read-only viewers cannot send input or access another run without authorization.
- No secret canaries in model requests, logs, artifacts, pixels, or exported media.
- Bounded cancellation/restart/disposal and no replay of uncertain mutations; cleanup failures visible.
- Computer tab and inline Copy/Download/Share work from a remote client with authenticated access checks.
- Share expiry/revocation, file traversal, unsafe HTML, forbidden origins/apps/paths, and forged approvals tested.
- No Cua Driver/Browse/Browser Automation BB plugin reinstallation.
- Typecheck, focused tests, build, and live plugin checks pass; no placeholder execution path advertised as functional.

Measure matched conditions with preview/recording off and on, multiple viewers, and export load. Initial targets, not claims: under 1 second p50 routine browser action, under 3 seconds p50 first meaningful action, below 1 second p95 live frame age on the declared connection, and at most 10% median execution overhead from preview. Desktop timings reported separately; OCR may dominate. Include startup, model latency/cost, waits, failures/timeouts, CPU/memory, bandwidth, and encoder cost.

Before reliability claims, use a held-out supported suite with at least 10 routes and 20 attempts each; aim for 95% verified success, with per-route outcomes and uncertainty. Expected safety stops are separate, never arrivals. Any unauthorized consequential action or secret leak blocks release. Upstream speed numbers and the historical 380-second CUA run are not verified comparisons.

## Deferred work

Parallel controlling runs, arbitrary desktop autonomy, persistent authenticated profiles, consequential actions, browser/desktop manual takeover, Bun migration, and automatic policy learning. Expand only after the single-controller browser/native/FS slice and remote viewing/artifact delivery are reliable.
