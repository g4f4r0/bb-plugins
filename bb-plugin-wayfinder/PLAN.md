# Wayfinder implementation plan

Status: reviewed planning document; not implemented or runtime-verified. Only this plan exists in the Wayfinder package directory, and `wayfinder` is not installed in BB.

## Review decisions

- Wayfinder must work without Cua Driver, Browse, or BB Browser Automation. Their BB installations have been removed at the user's request; do not reinstall them for a baseline or fallback.
- First milestone: a single-host, single-run, unauthenticated Fortress/CDP compatibility spike against local fixtures. No native desktop automation, reusable authenticated profiles, or automatic visual fallback.
- Unsupported controls produce a bounded `blocked` result and evidence for human review. A reasoning model can diagnose but cannot bypass policy.
- Published timings and dependency versions below are research inputs from the original plan, not independently reproduced facts. Verify their source, availability, license, and exact revisions before installing dependencies.
- Build the complete plugin only after the spike passes. This review does not establish browser compatibility, model availability, speed, or end-to-end correctness.

## Product statement

Wayfinder is an ultrafast browser-testing plugin for BB. A user or agent supplies a natural-language goal plus explicit assertions and safety boundaries. A persistent local worker executes routine browser actions through Fortress and CDP, uses Jev for fast bounded operation and target decisions, verifies outcomes independently, and returns a structured diagnostic trace with customer-ready evidence.

The main BB model should plan, diagnose, and handle ambiguity. It should not spend a full model turn on every click.

Proposed tagline:

> Wayfinder: ultrafast browser testing for agents.

## Why build it

The previous CUA workflow incurred a BB model/tool round trip for every observe-decide-act cycle. The original plan reported approximately 380 seconds for a Jackfir checkout test; the underlying timing artifacts still need verification.

The reference implementation in [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast) demonstrates a different control loop:

```text
DOM snapshot -> Jev operation + target -> direct CDP action -> repeat
```

Its published Google Flights run completed 10 interactions, one wait, 17 Jev requests, and two generated text values in 7.073 seconds. The reported median Jev latency was 178 ms. The evidence is narrow and supports investigating the architecture, not assuming it works in Fortress or meets Wayfinder's safety requirements.

Wayfinder should make routine DOM-based browser testing substantially faster while reducing expensive general-model usage. The capable model should usually be called once to prepare a test, only on exceptional states during execution, and once to diagnose a failure.

## Product vocabulary

- **Route**: a complete test specification.
- **Checkpoint**: a deterministic assertion.
- **Run**: one execution of a route.
- **Trail**: the structured action and evidence trace.
- **Detour**: a stopped run handed to a human or reasoning model for diagnosis; not an automatic desktop-control fallback.
- **Arrival**: independently verified completion.

## Goals

1. Execute ordinary browser flows 5-20 times faster than the current model-per-action CUA loop.
2. Keep the capable BB model out of successful routine execution loops.
3. Use Fortress as the controlled browser.
4. Use Jev for bounded operation and target selection over compact structured state.
5. Use deterministic code for execution, policy, arithmetic, waits, assertions, and verification.
6. Stop safely on visual-only browser states and native dialogs; require no external computer-use plugin.
7. Produce useful failure diagnoses without asking an agent to watch an entire video.
8. Produce clean screenshots and recordings suitable for customer delivery.
9. Support safe parallel execution in isolated temporary browser profiles.
10. Keep secrets out of model context, traces, recordings, logs, and source control.

## Non-goals for the first release

- General autonomous desktop operation.
- Solving or bypassing CAPTCHAs.
- Circumventing access controls, rate limits, or site policies.
- Executing orders, payments, external communications, deletions, permission changes, or other consequential actions in v1, even with confirmation.
- Full compatibility with every browser widget in the first version.
- Training or fine-tuning Jev.
- Treating Jev's `DONE` decision as proof of success.

## Core design principles

### Keep the hot loop local

A persistent worker owns the browser session and runs multiple observe-decide-act cycles from one BB tool invocation. It must not return to the main chat model after each browser action.

### Prefer structured browser state

The default observation is one atomic DOM snapshot containing visible text, visible supported controls, names, values, states, and code-owned node identities. Screenshots stay out of the Jev loop.

### Make the action space finite

Jev may choose only among operations and targets constructed from the current observation. Model output must never become a selector, coordinate, shell command, or executable JavaScript.

### Separate execution from verification

Jev chooses actions. Independent deterministic checkpoints decide whether the route passed. A `DONE` choice triggers verification; it does not establish success.

### Fail closed

Invalid model responses, stale targets, uncertain mutations, forbidden actions, low-confidence consequential decisions, and ambiguous completion must stop or escalate without retrying a potentially completed mutation.

### Capture evidence around events

The diagnostic agent should receive the failing checkpoint, sanitized DOM diff, network and console events, and permitted keyframes/video ranges when available. Explicitly mark evidence withheld for privacy or unavailable due to capture failure; never fabricate it.

## Reference implementation

The initial compatibility spike should pin and audit:

- `browser-use/jev-ultrafast` commit `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`
- `browser-harness` version `0.1.13`
- Jev `1.13` or the explicitly resolved tested model version

Relevant upstream files:

- `jev_ultrafast/agent.py`: bounded local execution loop
- `jev_ultrafast/snapshot.js`: atomic visible-control extraction
- `jev_ultrafast/browser.py`: persistent CDP session and guarded execution
- `jev_ultrafast/model.py`: dynamic operation and target questions
- `jev_ultrafast/questions.py`: execution policy

The upstream project is MIT licensed. Preserve attribution and license notices if code is vendored or adapted.

For the spike, use a dependency pinned to an exact commit. If the approach passes acceptance testing, vendor the small audited core or maintain an explicit fork so upstream changes cannot silently alter browser behavior.

## Proposed architecture

```text
BB agent or user
      |
      | computer_task(route)
      v
Wayfinder BB backend
      |
      +-- route compiler and policy validator
      +-- run/session supervisor
      +-- progress and confirmation events
      +-- artifact index
      |
      v
Persistent isolated worker
      |
      +-- Jev decision policy
      |     operation + operation-specific target heads
      |
      +-- small text helper
      |     field values only
      |
      +-- Fortress CDP adapter
      |     DOM snapshots and direct browser input
      |
      +-- unsupported-state detector
      |     bounded stop and diagnostic handoff
      |
      +-- assertion and verification engine
      +-- CDP network/console/performance collector
      +-- continuous recorder
```

### BB plugin backend

The TypeScript plugin should own:

- Agent-tool registration.
- Input parsing and typed route validation.
- Worker lifecycle and health checks.
- Per-run resource limits and cancellation.
- Confirmation pauses and resumes.
- Realtime progress events.
- Bounded tool output.
- Artifact paths and cleanup.
- Settings that do not contain secrets.
- Run ownership bound to the originating thread, project, environment, host, and plugin generation; enforce it on status, confirmation, cancellation, and artifact reads.

Start with one explicitly configured host. Refuse a request from a different host rather than silently launching on `bb-server`. The browser, sidecar, secret injection, and capture process must share the selected host. Later multi-host support uses the public `bb.hosts` contract and a `bb.host` entry, not an exposed Unix socket or CDP endpoint.

Before implementation, inspect the installed BB Plugin SDK declarations and read the plugin authoring references for backend tools, lifecycle, realtime events, testing, and optional frontend surfaces.

### Persistent worker

Use a supervised Python sidecar for the initial implementation because the reference engine and Browser Harness are Python packages. The sidecar should remain alive across actions but isolate native or browser failures from `bb-server`.

Communication should use a private Unix socket with a small typed protocol. The socket and parent directory must be owner-only, use a versioned protocol with bounded frames and request deadlines, and reject unknown or concurrent controllers for the same browser target. Check peer ownership where supported. This is a same-user boundary, not protection against hostile processes running under the same account.

The worker owns:

- Fortress launch and target binding.
- Browser Harness/CDP connection.
- The local decision loop.
- Jev and text-helper calls.
- Assertions and event capture.
- Unsupported-state detection and diagnostic handoffs.
- Run trace serialization.

### Fortress session

Each run should use:

- A dedicated temporary user-data directory by default.
- An explicit loopback-only remote-debugging port.
- An exact CDP browser and target identity.
- A deterministic viewport and window frame.
- Browser-only capture by default; optional synthetic wallpaper margins composed after capture, without reading unrelated desktop windows.
- Isolated temporary state only in v1; reusable profiles are deferred.
- Cleanup after success, failure, timeout, or cancellation.

Browser Harness should connect through an explicit `BU_CDP_URL`. Do not depend on automatic Chrome profile discovery. Never attach to a user's existing browser or expose CDP via BB Connect. Resolve the actual executable, version, platform support, and license before launch; do not assume Fortress is installed or compatible.

### Run lifecycle and recovery

Use explicit states: `queued`, `running`, `awaiting_confirmation`, `verifying`, and terminal `passed`, `failed`, `blocked`, `cancelled`, `timed_out`, `interrupted`. Record the last durable state and a separate cleanup result.

Starting a run returns a run ID promptly; the worker continues locally. An optional bounded wait may return a terminal result, but a tool/RPC timeout must not create a duplicate run. Deduplicate starts using a caller-scoped idempotency key and route hash. Status polls never drive browser actions.

Journal action intent before dispatch and result after dispatch. A crash between them is an uncertain mutation: mark the run `interrupted`, never replay it automatically. Lease expiry, thread/environment disposal, plugin reload/disable/uninstall, worker death, timeout, and cancellation must stop owned child process groups and close targets. Use heartbeat expiry and startup reconciliation for crashes where dispose hooks cannot run. Cancellation is idempotent, bounded, and reports incomplete cleanup; never kill an unrelated browser. Keep durable sanitized artifacts outside disposable profile and worker directories.

The supervisor must account for BB's host RPC timeout and worker idle eviction; use bounded start/status calls and an explicit worker lease if using host RPC. Progress events are hints; persisted status is authoritative.

### Jev policy

Each decision request should include:

- The route goal.
- Current URL and title.
- Visible page text, bounded to a configured limit.
- Indexed visible elements and their supported operations.
- Current values and checked, selected, and expanded states.
- Recent actions and whether they changed the page.
- Only the operation and target questions needed for the current action space.

One TypeSafe request should evaluate the operation and speculative operation-specific targets in parallel. The executor consumes only the target head corresponding to the selected operation.

Initial operations:

- `CLICK`
- `TYPE_TEXT`
- `SELECT`
- `SCROLL_UP`
- `SCROLL_DOWN`
- `WAIT`
- `DONE`
- `BLOCKED`
- `UNSUPPORTED`
- `REQUIRE_CONFIRMATION`

Add confidence gates. The reference implementation validates response shape but generally executes the maximum-probability choice. Wayfinder must stop or escalate when operation or target confidence falls below route policy. Verify that the selected provider actually exposes these scores; missing scores must not become confidence 1.0. Calibrate thresholds on held-out fixtures. Confidence is not authorization and cannot make a forbidden action safe.

Every decision is bound to a run, document generation, frame, snapshot ID, and code-owned node identity. Immediately before dispatch, revalidate identity, supported operation, visibility, enabled/read-only state, hit target, and policy. A changed document invalidates the decision. Bound observation size, wait duration, provider retries, no-progress loops, token usage, and per-run spend.

### Text helper

A small low-latency language model generates text only after Jev chooses `TYPE_TEXT` and a specific observed field.

The helper receives:

- Original route goal.
- Selected field name, role, and current value.
- Bounded visible context.
- Recent relevant actions.

It must return exactly one typed JSON value. It may not generate browser actions. It must never invent missing personal information. Credentials and secret values should bypass the model and be injected only after the field target is resolved.

### Unsupported states and detours

Canvas controls, visual-only interfaces, unsupported frames/shadow roots, native dialogs, complex drag-and-drop, and inaccessible DOM stop the run with `blocked` and a concrete reason. Do not invoke Cua Driver, Browse, BB Browser Automation, or another computer-use plugin.

A human or reasoning model may inspect sanitized evidence and propose a separately approved route or adapter change. Manual completion is not an automated pass. Final visual review is optional human review, separate from deterministic checkpoint results. Any future visual adapter requires a new design review and must preserve the same target, policy, and confirmation boundaries.

## Proposed agent tools

Keep the public tool set small.

### `computer_task`

Validates and starts a route, returning a run ID and bounded initial status. The worker runs independently until arrival, failure, confirmation, timeout, cancellation, or a bounded escalation. Keep these names provisional; check collisions before registration and prefer a Wayfinder-specific prefix.

Input should include:

- Goal.
- Start URL.
- Checkpoints.
- Forbidden actions.
- Domain allowlist.
- Maximum steps and runtime.
- Profile policy.
- Recording policy.
- Confidence policy.

### `computer_task_confirm`

Resumes a paused run after explicit user confirmation. The confirmation must be scoped to one described action and one observed state. An agent-supplied `confirmed: true` is not user consent: use a BB user interaction with server-verifiable provenance. Bind a single-use, expiring approval to the run, route/policy hash, action payload, target, origin, and document fingerprint. Revalidate before dispatch and ask again if anything changes. Persisted policy always overrides approval; a forbidden action cannot be confirmed into permission. The first release stops at consequential boundaries instead of executing payments, orders, deletions, or account changes.

### `computer_task_status`

Returns bounded progress, current state, timings, and any pending confirmation or diagnostic summary.

### `computer_task_cancel`

Stops the run, closes owned resources, finalizes available evidence, and reports cleanup results.

A future frontend panel may provide live progress, confirmations, preview frames, and artifact navigation. It is not required for the compatibility spike.

## Route format

Illustrative route:

```yaml
name: jackfir-classic-shave-checkout
startUrl: https://jackfir.com

goal: >
  Add one Classic Shave Cream as a one-time purchase and continue through
  checkout until payment is required. Do not submit payment or place an order.

domains:
  - jackfir.com

checkpoints:
  - product title is "The Classic Shave Cream"
  - purchase type is "One-time purchase"
  - cart contains "The Classic Shave Cream"
  - cart quantity equals 1
  - checkout contact section is visible
  - payment section is visible

forbid:
  - click text matching "Pay now"
  - click text matching "Place order"
  - submit a payment form

limits:
  maxActions: 60
  maxDecisionRequests: 120
  timeoutSeconds: 120

recording:
  enabled: true
  customerReady: true
```

This YAML is a human-readable sketch, not an executable or safety-complete route. Use a versioned strict JSON Schema, reject unknown fields, and validate URL schemes, origins, numeric limits, and assertion types. The illustrative single-domain list may not cover real checkout origins; do not infer or auto-allow additional domains.

Compile natural-language checkpoints outside the hot loop. Show and approve the exact typed predicates and resolved policy before execution; reject unsupported or ambiguous assertions. Distinguish historical checkpoints (observed at a named step) from final-state checkpoints, so a product-page assertion does not have to remain visible at checkout. Require all mandatory checkpoints to pass; `unknown`, absent evidence, and an empty assertion list cannot produce `passed`.

## Assertion and verification engine

Supported deterministic checkpoints should begin with:

- URL equals, contains, or matches a safe pattern.
- Visible text exists or does not exist.
- Element with role and accessible name exists.
- Field value equals an expected value.
- Checkbox, radio, switch, or option has an expected state.
- Cart or table row contains expected structured values.
- Network request completed with an allowed status.
- Console contains no uncaught error matching policy.
- Page reached a stable state within a time budget.
- No policy violation was observed in the executor's audited action stream (not proof that the website produced no side effects).

Routes may add site-specific verifiers as trusted code. Verifiers must be read-only, bounded, and separately tested.

## Trace and diagnostics

Every run should create a structured trail containing:

- Route and resolved policy.
- Environment and version metadata.
- Model versions.
- Browser and viewport information.
- Every observation fingerprint.
- Candidate operations and targets.
- Jev probabilities and latency.
- Selected action and exact observed target identity.
- Execution timestamps and effects.
- Relevant DOM changes.
- Network failures and selected request metadata.
- Console errors.
- Checkpoint evaluations.
- Detours and confirmation events.
- Resource and model usage.
- Artifact hashes.

Do not store secret field values, authorization headers, cookies, tokens, or unsanitized sensitive responses. Sanitize before serialization, hashing, logging, or sending content to a provider. Hashing low-entropy sensitive values is not redaction. Strip URL queries/fragments by default and allowlist retained network fields; do not capture bodies by default.

Artifacts require authenticated, run-scoped access, safe generated paths, retention and byte limits, and an explicit deletion policy. Customer delivery is a separate user-approved export, not a public URL by default. Artifact creation failure must be reported without masking the primary run result.

### Failure packet

The main BB model should receive a compact failure packet rather than the entire trail:

```text
Failure category
Failed checkpoint
Expected state
Observed state
Relevant actions
Operation and target confidence
Relevant DOM diff
Relevant network and console events
Before and after keyframes
Short video range
Links to the full trail and recording
```

### Failure categories

- **Product defect**: correct interaction, incorrect application outcome.
- **Automation failure**: wrong target, unsupported control, stale state, or execution error.
- **Route-definition problem**: ambiguous goal or invalid/outdated checkpoint.
- **Environment failure**: network, browser, provider, or infrastructure problem.
- **Safety stop**: policy or confirmation boundary prevented continuation.

The diagnostic model may propose an application fix, route update, or executor improvement. It must not silently rewrite the route and count the rerun as passing.

## Recording and presentation

Recording must remain outside the decision loop.

Requirements:

- 1280x720 customer-ready output.
- Browser viewport at a deterministic frame, without capturing other applications.
- Optional synthetic BB/Dusk-style wallpaper margins added during export.
- Standard cursor with a restrained optional click indicator.
- No CUA high-visibility overlay.
- Continuous capture with original timing only for synthetic, non-sensitive fixture runs. Recording is off by default for other runs; protected intervals produce explicit gaps rather than unredacted frames.
- Event markers mapped to recording timestamps.
- Failure clip export around the relevant event.
- H.264, `yuv420p`, mobile-compatible output.
- Byte-range streaming for inline playback; do not embed the full MP4 as a base64 data URL.

## Safety and secrets

- Resolve all credentials through Infisical at runtime, including model-provider credentials. Verify project, environment, and narrow folder scope first. Use process injection, not values in shell arguments or BB settings. Missing authentication is a prerequisite failure, not a browser-login task.
- Never persist `.env` files when process injection works.
- Never include credential values in prompts, traces, logs, screenshots, videos, shell arguments, or artifacts.
- Resolve the target field before injecting a secret.
- Password-field masking alone is insufficient: sensitive values can appear in text, URLs, autocomplete, console output, or pixels. Before secret injection, suspend capture and model-visible observation until an independently checked safe state. V1 uses synthetic non-sensitive data; authenticated flows remain deferred until leak tests pass. Never send Infisical credentials through a browser.
- Separate exact navigation origins from permitted resource/API origins. Validate redirects, popups, frames, workers, WebSockets, downloads, and non-HTTP schemes. Deny loopback, private/link-local networks, and metadata endpoints except explicit local fixture origins; address DNS rebinding at the network isolation layer. A hostname string check alone is not an SSRF boundary.
- A denylist of button text is not a safety boundary: form submit, Enter, JavaScript handlers, and navigation can all mutate state. The first live routes must be reviewed and stop before consequential actions. Prove pre-dispatch blocking in controlled fixtures, including service-worker traffic; if interception coverage cannot be established, restrict the spike to fixtures/test stores. Do not promise arbitrary-site side-effect prevention through CDP alone.
- Stop before payments, purchases, external communication, deletion, permissions, account changes, and other consequential actions in v1. Future execution requires separately reviewed enforcement and explicit user confirmation.
- Keep policy enforcement in code. Prompt instructions cannot relax it.
- Verify that cancellation and timeout close owned targets and temporary profiles.

## Performance and cost telemetry

Collect per run:

- Total elapsed time.
- Time to first meaningful action.
- Observation latency.
- Jev request count and latency distribution.
- Text-helper calls and latency.
- CDP call count.
- Unsupported-state handoff count and time spent paused.
- Network wait duration.
- Input and output tokens by model.
- Provider-reported cost when available.
- General-model escalation count.

The published reference used approximately 90,558 TypeSafe input tokens across 17 requests. Jev is intended to process these cheaply, but Wayfinder must measure real billing rather than assuming cost from latency.

## Implementation phases

### Phase 0: baseline

Recover existing CUA-based Jackfir timing artifacts if available; label the approximately 380-second figure historical and unverified otherwise. Do not reinstall removed computer-use plugins to reproduce it. Establish a new deterministic local-fixture baseline using the same browser, viewport, network conditions, checkpoints, and recording policy as the spike.

Deliverables:

- Action-by-action timing.
- Model, tool, observation, execution, wait, and recording breakdown.
- Stable route and deterministic verifier used by every later comparison.

### Phase 1: Fortress compatibility spike

Run the pinned Jev Ultrafast engine outside BB against a dedicated Fortress session. First audit upstream code and lock all Python dependencies (including transitive dependencies and hashes), model IDs, Node/SDK versions, and browser version. Verify provider access and budget through scoped Infisical injection.

Start with offline policy tests and a controlled fixture store. Only after safety tests pass, and live-site scope is approved, run these candidate tasks without real personal/payment data:

1. Wikipedia navigation.
2. Jackfir product navigation.
3. Add the Classic Shave Cream as a one-time purchase.
4. Reach checkout and stop before payment submission.

Verify:

- Browser Harness connects through explicit `BU_CDP_URL`.
- Target identity remains stable.
- Fortress/CDP is compatible on the selected host; record any change in browser behavior without attempting to bypass challenges or access controls.
- Background focus emulation does not break the visible recording.
- Temporary profiles clean up correctly.
- Independent Jackfir checkpoints pass.

This phase is a go/no-go gate. Do not build the complete BB plugin until Fortress compatibility and speed are measured.

### Phase 2: hardened worker

Add:

- Typed route schema.
- Domain and action policy.
- Confidence gates.
- Confirmation states.
- Independent verifiers.
- Sanitized traces.
- Network and console collection.
- Timeouts, cancellation, and resource cleanup.
- Clean recording and event markers.
- Unsupported-state stop and handoff interface.

### Phase 3: BB backend plugin

Create the plugin manifest, backend entrypoint, supervised worker service, agent tools, settings, storage boundaries, and lifecycle cleanup.

Add focused tests for:

- Tool input validation.
- Worker restart and disposal.
- Cancellation.
- Confirmation scoping.
- Bounded output.
- Policy enforcement.
- Secret redaction.

### Phase 4: frontend experience

If the backend proves useful, add:

- Live run progress.
- Current action and elapsed time.
- Confirmation cards.
- Lightweight preview frames.
- Trail timeline.
- Failure packet view.
- Inline range-streamed recording.

### Phase 5: parallel test runner

Add bounded concurrency with one isolated Fortress profile and exact target per run. Respect BB host concurrency and machine capacity.

Support:

- Route suites.
- Tags and environment selection.
- Retry policy limited to safe read-only or independently idempotent routes.
- Aggregate reports.
- Comparison against prior accepted runs.

### Phase 6: learning from failures

Aggregate sanitized automation-failure categories to guide engineering improvements:

- Date-picker adapter.
- Frame and shadow-root traversal.
- Better checked-state extraction.
- Improved settling policy.
- Earlier detection of unsupported states.
- Site-specific trusted verifiers.

Do not automatically change production policy from model suggestions. Every change requires tests and measured comparison.

## Acceptance criteria

### Compatibility spike

- Fortress connects reliably through an explicit CDP endpoint.
- The Wikipedia route passes in under 10 seconds on repeated runs.
- The Jackfir product-to-cart route passes in under 20 seconds on repeated runs.
- The full Jackfir route reaches the payment boundary in under 60 seconds at median.
- No run clicks or submits a forbidden payment or order action.

These are targets, not promises. Record full distributions and failures. Use at least 20 attempts per route per configuration; report cold and warm launches separately, success counts, median/p95 end-to-end times, costs, and every failure/timeout. Compare matched conditions; do not drop failures or exclude model, startup, and recording overhead from end-to-end claims. If the historical CUA baseline cannot be reproduced from artifacts, make no verified speedup claim against it.

### First plugin release

- At least 95% success on a versioned held-out suite of at least 10 supported routes and 20 attempts per route. Report per-route results and uncertainty; expected safety blocks are tested separately and never counted as successful arrivals. Any unauthorized consequential action or secret leak is a release blocker regardless of aggregate success.
- Routine deterministic browser actions complete under 1 second at p50.
- First meaningful action occurs under 3 seconds at p50.
- Every pass is established by independent checkpoints.
- Every failure produces a bounded diagnostic packet.
- Cancellation closes owned resources.
- No secrets appear in logs, trails, screenshots, recordings, or tool output.
- Unsupported states stop explicitly without invoking a removed plugin.
- Plugin build, typecheck, focused tests, and live BB workflow pass.

## Test strategy

### Offline tests

- Dynamic action-space construction.
- Operation-specific target isolation.
- Model-response validation.
- Stale-decision rejection.
- Mutation non-retry guarantees.
- Route parsing and policy compilation.
- Forbidden-action matching.
- Confirmation boundaries.
- Secret redaction, including URL/DOM/console/model payload canaries and pixel/recording checks.
- Run ownership, forged/expired/replayed confirmations, and cross-thread artifact access.
- Crash-after-dispatch reconciliation, duplicate starts, lease expiry, reload/uninstall, and incomplete cleanup.
- Redirects, popups, private-network targets, service workers, and action paths that bypass button clicks.
- Assertion evaluation, including historical versus final predicates and unknown results.
- Failure classification.
- Trace bounds.

### Local browser fixtures

- Replaced and disconnected nodes.
- Hidden, disabled, readonly, and covered controls.
- Checkboxes, radios, switches, text fields, and native selects.
- Autocomplete arrival.
- Navigation during action.
- Loading and no-progress loops.
- Console and network failures.
- Iframes, shadow DOM, canvas, and other unsupported-state triggers.

### Live routes

Use a small versioned suite with independent verifiers. Separate development routes from untouched acceptance routes. Retain source hashes, model versions, browser version, timings, costs, and every failure.

## Risks

### Reliability beyond the demos

Jev Ultrafast is new and reports results from only a few tasks. Mitigation: require the compatibility spike and fixed-route evaluation before productizing claims.

### Large dynamic pages

Up to 250 candidates and repeated target heads can create large Jev requests. Mitigation: deterministic filtering, relevance grouping, viewport scoping, and measured context budgets.

### Prompt injection in page content

Jev receives page text as untrusted data but may still be influenced. Mitigation: constrained choices, domain policy, code-owned targets, forbidden-action checks, minimal visible text, and adversarial fixture tests.

### CDP and browser compatibility

Remote debugging may alter Fortress behavior. Mitigation: measure supported browser behavior before and after CDP connection on controlled fixtures. Stop at CAPTCHAs and access challenges; compatibility is not permission to bypass them.

### Ambiguous mutations

A navigation can interrupt confirmation after an action may already have executed. Mitigation: never retry uncertain mutations; stop and verify state independently.

### Provider dependency

The hot loop depends on TypeSafe and a small text provider. Mitigation: bounded retries before action, provider health reporting, exact model-version telemetry, and no action after an uncertain provider response.

### Cost assumptions

Fast does not automatically mean free. Mitigation: capture actual token and billing telemetry during the spike.

### Plugin crash impact

Embedding browser and native runtimes directly in `bb-server` increases blast radius. Mitigation: use a supervised sidecar and a narrow local protocol.

## Open decisions

1. Whether to vendor the audited Jev Ultrafast core or maintain a pinned fork after the spike.
2. Which small text model gives the best latency and field accuracy for our routes.
3. Initial Jev operation and target confidence thresholds.
4. Whether the first release needs a frontend panel or backend tools and artifacts are sufficient.
5. The exact route schema and natural-language-to-checkpoint compilation boundary.
6. How much sanitized network response content to retain for diagnostics.
7. Requirements for reusable authenticated profiles after v1 (excluded from the first release).
8. The maximum safe parallelism for this server.
9. Package and brand availability for `Wayfinder` before public release.

## Planned repository layout

No implementation files should be added as part of this plan review. Next approval gate: implement the isolated Phase 0/1 spike, not the complete plugin. Before that spike, settle the exact provider/model access, executable/browser support, dependency lock, typed fixture routes, and local network isolation approach.

```text
bb-plugin-wayfinder/
  PLAN.md
  package.json
  package-lock.json
  bb-plugin.json
  server.ts
  src/
    routes/
    policy/
    supervisor/
    tools/
    artifacts/
  worker/
    pyproject.toml
    wayfinder/
      agent.py
      browser.py
      model.py
      policy.py
      verify.py
      trace.py
      unsupported.py
  tests/
  skills/
```

The final layout must follow the current BB plugin scaffold and installed SDK contracts rather than this illustrative tree.

## Go/no-go decision

Proceed to a complete plugin only if the Fortress compatibility spike demonstrates:

1. A material end-to-end speed improvement.
2. Reliable independent verification.
3. Acceptable Jev and text-helper cost.
4. No regression in Fortress's required browser behavior.
5. Clean cancellation and profile isolation.
6. A reliable, bounded stop and diagnostic handoff for unsupported controls, without computer-use plugin dependencies.

If those conditions hold, Wayfinder can turn browser testing from a slow conversational process into a fast, repeatable execution system while reserving capable-model tokens for planning and diagnosis.
