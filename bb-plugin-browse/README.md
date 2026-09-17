# Browse for BB

A browser automation plugin built around **Fortress 151 with deterministic CDP control**. By default, Browse launches Fortress on **the machine where your BB thread executes**. An explicit `hostId` can select any other connected machine. Existing sessions stay on that host when the thread moves. It works independently of the client device. Explicit native mode can also control BB desktop tabs.

**Browse** is the plugin name, ID (`browse`), CLI (`bb browse`), and agent tools (`browse_session`, `browse_action`, `browse_job`, `browse_discover`, `browse_credentials`). Fortress is the browser engine; Browse drives it through deterministic CDP commands.

No Browserbase, Browser Use Cloud, AI Gateway, Stagehand API, or second model is required. Your existing BB agent makes the decisions. Browse and its local Fortress engine execute them.

## Use it

Browse runs through agent tools and the `bb browse` CLI. It adds a dependency page in Settings and a Browser tab in the thread side panel. The plugin remains visible in BB’s Installed plugins management list.

Start with `bb browse start '{"url":"https://example.com"}'` from a BB thread. Browse resolves that thread’s environment host and opens headed Fortress. The live page appears in the thread panel. Run `probe` to check readiness and `setup` to install dependencies, including Xvfb, xkbcomp, and XKB keymap data on Linux hosts without a display. Settings lists all enrolled machines with independent checks and installation actions; offline machines are shown separately.

The viewer is a custom authenticated web view. It streams binary JPEG frames into a canvas, with direct pointer movement, dragging, text selection, keyboard events, Unicode paste and scrolling. Each session opens as its own BB side-panel tab; the machine appears in the lower-right corner. The Open browser launcher lists this thread’s sessions across hosts. Routine refreshes preserve the selected tab. Relative viewer URLs resolve against the current BB web origin.

### Annotations

Press the annotate button in the viewer toolbar (⌘. or Ctrl+.) to point at page elements. Hovering outlines the element under the pointer; clicking opens a comment field. When the field is empty its button starts voice input: the popover switches to BB's composer recorder (cancel, live waveform, confirm) and transcribes with BB's own service. Once there is text, the button adds the annotation. An unsaved pick is discarded when the viewport size or page changes. Each annotation becomes its own mention pill in the thread composer. When the message is sent, the pill resolves to a `<browser_annotation>` block with the page URL, comment, selector, text, HTML, key styles, the element's viewport rect, and the path of a cropped PNG on the Browse host. Numbered markers stay on the page while annotating. Click one to edit its comment, or clear the comment to delete it. Annotations are also listed under "Browser annotations" in the composer's `@` menu and are kept for seven days.

`mode:"native"` retains the existing desktop backend and requires fresh hostId, instanceId and generation. The legacy preferredHost applies only to native discovery; it never changes managed placement.

Agents get five tools:

| Tool                     | Purpose                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `browse_discover` | Machines, desktops, and this thread’s sessions                           |
| `browse_session`  | Attach/create, tabs, setup, reveal, release, explicit close, files       |
| `browse_action`   | Inspection, commands, batches, shadow DOM controls, strokes and captures |
| `browse_credentials` | Private user form → bound browser login, with device AutoFill |
| `browse_job`      | Poll or cancel long actions                                              |

Tools and the bundled skill become available when BB refreshes the agent session. The same functionality is available immediately through `bb browse help`.

## Private login forms

Managed Fortress disables password saving, automatic sign-in, password filling, and address/payment autofill before every launch and reconnect. Password filling uses Chromium’s `password_manager.password_manager_blocklist` with `*`; disabling saving alone still permits filling. Preferences are merged atomically without deleting cookies, saved credentials, or other profile settings. This applies to Browse-managed Fortress, not native BB tabs, device password managers, or suggestions implemented by websites. Verified with the pinned Fortress 151 runtime using `npx tsx tests/profile-preferences-live.mts <host-data-path>`.

Browse can request username, password, or verification-code fields through BB's private input UI, using the same SDK mechanism as the built-in Secrets plugin. Device password managers such as 1Password can fill this form. No vault connection or service account is required. Environment-variable requests still use Secrets.

The request starts a credentials job immediately (agents poll it; the CLI waits). It works on the selected managed or native session, locks automation for up to five minutes, keeps the live view available, binds to the original document and fields, then fills and clicks once. Values are excluded from its result and job history, and are not written to dotenv files. Existing input nodes are cleared after delivery. Cancellation before filling preserves the page.

Fields may be in the top document, an open shadow root, or an iframe that uniquely matches. Continue may be a button, `input type=submit|button`, or `role=button`. HTTPS or loopback HTTP fixtures and same-origin POST forms are required when a form is present. Stop recording before requesting. Unsupported forms, ambiguous matches, and page changes fail closed. A delivery result is not proof of successful login; inspect the following page. Browser/host access remains trusted: destination scripts can retain submitted values, and this feature does not isolate secrets from arbitrary browser scripting or shell access.

On iPhone, use AutoFill → Passwords and choose 1Password. Since the form is on BB's domain, selecting another site's login may require manual selection and Allow Once. iPhone hardware validation is separate from the automated Chromium tests.

## What improves browser use

- **Local execution:** each command, batch or continuous gesture runs beside the browser instead of round-tripping every mouse move through the agent/server.
- **Richer observations:** accessibility refs plus visible DOM controls, open shadow roots, labels, selectors, colors and CSS-pixel bounds. Useful for canvas apps and custom elements whose basic accessibility snapshot is incomplete.
- **Precise interaction:** unique-element matching, bounded waits for stable/uncovered targets, disabled/read-only checks, verified field filling without redundant mouse events, and continuous pointer paths with guaranteed release on normal completion or gesture cancellation.
- **Explicit tab binding:** each managed session owns an isolated profile and pinned page; native mode pins the selected BB tab. Failed setup never falls back to another machine.
- **Short and long operations:** quick commands return directly; longer work returns a job ID, progress timing and cancellation. A failed action is never silently replayed.
- **Artifacts:** actual PNG files, original canvas export, native PDF (image-based in desktop mode), link/button downloads and WebM recording, with BB file-preview links and inline image output for agents.

This improves the execution and observation layer. It is not a claim that every model or website will achieve a particular success rate or benchmark score.

## Agent capability benchmark

The reproducible [MiniWoB++ benchmark harness](benchmarks/agent-capability/README.md) covers twelve representative browser tasks with pinned source, deterministic seeds, action budgets, and direct reward scoring. Run its local site with `npm run benchmark:site`. `npm run benchmark:capabilities` runs five live Fortress trials for each previously weak widget pattern: custom clickable controls, autocomplete, datepicker workflows, and sortable drag. It measures browser primitives without model calls.

## Architecture

```text
BB agent / CLI / Settings / live viewer
                  │ typed RPC / authenticated viewer routes
                  ▼
            BB plugin server
                  │ resolves thread → environment → host
                  ▼
           Thread execution host
   Host worker ── persistent deterministic CDP control
          └──── private CDP ── managed Fortress
```

Fortress’s debugging endpoint binds to loopback and is never sent to the client. Viewer routes use BB’s origin authentication and only accept bounded actions, never arbitrary CDP. The native desktop backend keeps its scoped connection adapter and BB control leases.

The pinned engine is integrity verified. Its browser installer downloads Fortress. On Debian/Ubuntu, Browse can download and extract missing Chromium libraries and FFmpeg into its private data directory without administrator access. Other operating systems use their installed browser libraries and FFmpeg. Dependency checks distinguish an installed executable from a successful browser launch. Close managed sessions before updating dependencies.

## Action examples

```json
{"kind":"observe","screenshot":true}
{"kind":"command","args":["click","@0-19"]}
{"kind":"batch","commands":[["fill","@0-20","hello"],["click","@0-21"]]}
{"kind":"element","action":"fill","selector":"my-app >>> input[name='query']","value":"hello"}
{"kind":"gesture","strokes":[[{"x":100,"y":100},{"x":110,"y":105},{"x":120,"y":120}]],"intervalMs":8}
{"kind":"screenshot","fullPage":false}
{"kind":"canvas","selector":"paint-app >>> paint-canvas >>> canvas.main"}
{"kind":"record","action":"start","fps":20}
{"kind":"record","action":"stop","fps":20}
```

`element` actions use deterministic CDP element targeting in the top document. For frame commands, use `["frame","iframe#editor"]`, run the actions, then use `["frame","main"]`; this also works with cross-origin frames. Use fresh snapshot references for closed shadow roots. Some compound CSS selectors do not cross closed roots; use the snapshot reference in that case. `eval`, top-level DOM observations, and canvas exports use the top page. Gesture points remain relative to the top viewport; Browse applies the selected frame offset. Closed shadow roots and cross-origin frame restrictions can still limit inspection and export.

`sequence` runs up to 50 known operations in one local job, stopping on the first failure and reporting completed step indexes, durations, and artifacts. It never retries completed steps. Use small sequences between decisions:

```json
{"kind":"sequence","steps":[{"kind":"element","action":"fill","selector":"#name","value":"Alice"},{"kind":"element","action":"fill","selector":"#city","value":"Berlin"},{"kind":"observe"}]}
```

Element `waitMs` defaults to 3000 (maximum 30000; zero fails immediately when not ready). Waits only retry missing, moving, replaced, hidden, or covered target checks **before input**. Ambiguous or disabled targets fail immediately. A timed-out input is never replayed. Screenshots during recording preserve the recording if native capture fails.

## Lifecycle and limits

- Browse Settings defaults to three active browser sessions per thread, eight active sessions across the plugin, and a 15-minute managed-session idle timeout. The limits are configurable from 1–20 per thread, 1–100 total, and 1–1,440 idle minutes. Concurrent starts reserve capacity before creating a browser or native tab. Limit errors report the current count and tell the user to reuse, close, wait for cleanup, or change the named setting.
- Managed sessions use the configured idle timeout (15 minutes by default); frame polling and inspection do not renew it. Plugin reload or disable still stops Fortress. Expiry, release, or disconnection never silently reacquires control. Reconnect opens a new window at the last URL with cookies and storage, not the previous DOM.
- Managed release/close and plugin reload/disable stop Fortress, keeping profile data and saved artifacts. Reconnect reopens the last known URL with cookies/local storage, not unsaved page state. Native release preserves the BB tab. A thread host change requires a new profile on that host; profiles are not silently copied.
- One job runs per session. Default deadline is 120 seconds; maximum 600. Ordinary output is bounded to 512 KB; observations inspect at most 12,000 DOM nodes and return at most 150 candidates.
- Cancelling a continuous gesture releases its held pointer. Cancelling another operation closes the control channel and stops managed Fortress to prevent remaining browser-side work; reconnect before further actions. Already completed page changes are not rolled back.
- Managed PDF uses Chromium printing and preserves text where supported. Native mode exports an image-based capture PDF.
- Direct link downloads support accessible HTTP(S), blob and data URLs up to 16 MB through the authenticated page. CORS can block cross-origin files. Managed `downloadClick` captures one button-triggered browser download, up to 128 MB, with a 60-second completion deadline. Native mode supports link fetches only. CSS download selectors resolve against the top page’s base URI and support open shadow roots; absolute-href accessibility refs are also accepted.
- Screenshots capture the web page, excluding BB/OS chrome. Full-page capture includes scrollable content. A tainted canvas may refuse PNG export.
- Artifact links expire after an hour; refresh the files list for new links. Files remain on the browser machine. Use BB’s host-aware file APIs to transfer them.
- No automatic mutation retries, credential import, paid backend, or autonomous secondary agent.

The previous Browser Automation plugin can be disabled after validation. BB’s native browser remains installed and visible, and the core `bb browser` command remains available. A plugin cannot remove BB core capabilities from the shell.

## Develop

Requires BB >=0.43 and SDK >=0.4.87. The SDK is pinned at 0.4.87.

```sh
npm install
npm run check
npm test
npm run build
bb plugin install . --yes
```

After source changes: build, then `bb plugin reload browse`. Reload releases active control, so reconnect existing tabs afterward.

See [FORTRESS-VALIDATION.md](FORTRESS-VALIDATION.md) for the engine/control A/B results, live bot-detection evidence, and direct-driver integration coverage. [EDGE-VALIDATION.md](EDGE-VALIDATION.md) and [VALIDATION.md](VALIDATION.md) contain the broader edge-case and viewer checks. The project uses only public BB SDK entrypoints.

## Upstream

- [Fortress](https://github.com/tiliondev/fortress), BSD-3-Clause
- `ws`, MIT

This is an independently authored BB integration, not a Browserbase or BB official plugin.

See [managed implementation validation](MANAGED-VALIDATION.md) for live Settings/viewer evidence, test results, artifacts and platform limits.

### Session reuse and cleanup

Managed starts at the same current URL reuse a session belonging to the current thread and host, including concurrent starts. `newTab:true` requests a separate isolated browser. Navigate an existing session with an `open` action to avoid opening additional browsers for unrelated URLs. Reuse preserves the current page state and reports any active job.

Release is idempotent and stops the owned Fortress process and its browser control connection. Cancelled non-gesture actions invalidate and release their session; reconnect reopens its saved profile. Finished job results are evicted oldest-first above 200 entries or an 8 MiB serialized-payload budget, retaining the most recent result and running jobs. This is a history bound, not a total process-memory limit; profiles and saved artifacts remain on disk.

### Handoff and native recovery

`reveal` reports whether a panel handoff was requested, recent visible-frame acknowledgments, the session/host identity, and a viewer URL. An agent call cannot identify your current client; `ok` does not prove that you saw the page. Open the returned URL against your current BB address when the panel is unavailable.

Native leases use BB’s 30-minute maximum. Fresh discovery replaces stale generations before acquisition; a generation change during an active session requires explicit reconnect and never replays an action. Failed starts close newly created tabs where possible and report the tab identity and cleanup result. Existing tabs are preserved. Private login needs six minutes remaining on a native lease.

Linux hosts need no desktop shell: managed Fortress uses a virtual display. Browse panels are streamed pages inside BB, not Electron-native tabs. Browse does not attach arbitrary existing Fortress windows or automatically expose website-created popup windows. Different managed sessions have isolated login cookies. Native capture can require the desktop tab to remain visible. CAPTCHA, passkeys and device-specific login may require manual interaction; website anti-bot restrictions are not removed by remote viewing.

See [multi-host validation](MULTI-HOST-VALIDATION.md) for the September 2026 browser handoff, login and recovery checks. macOS and Windows use their own desktop display; Xvfb is required only on Linux without a display. A native session’s panel offers a separate managed browser on the same host when native rendering is unavailable; that browser has a separate login profile.

### Native launcher visibility

While Browse is enabled, its client content script hides BB’s built-in “Open browser” action and its reorder handle. The Browse “Browser” action remains available. Disabling Browse restores the native launcher. This is a scoped UI override using the core action’s DOM ID; it does not disable the native browser engine, existing tabs, external-link preferences or core shortcuts. A BB update that changes that ID will need a selector update.

### Web links

While viewing a thread, ordinary clicks on absolute external HTTP(S) links in the BB app open a managed Browse session on that thread's host. This includes ordinary clicks on links marked `_blank`. Repeated clicks during launch are coalesced, and an existing session at that URL can be reused. The resulting session opens in a Browse panel; failures offer Retry.

Modified clicks, middle clicks, downloads, named frame targets, editable content, relative URLs, same-origin BB routes and links outside a thread keep their normal behavior. Viewer iframe links stay within that browser. A container can opt out with `data-browse-link-routing="off"`. Disabling Browse removes the listener. Programmatic core navigation, native shortcuts and the native engine remain available; this does not change BB's saved browser preference.


### Fortress runtime

Browse installs the lockfile-pinned Fortress package metadata, downloads the matching Fortress 151 native release, and verifies its published SHA-256 checksum before extraction. Browse launches the binary directly with an isolated persistent profile and connects through loopback CDP. There is no Stagehand runtime, extension, Browserbase account, API key, hosted browser, or second model in production.

Automation refs such as `@0-19` come from Chromium's accessibility tree and stay bound to backend DOM nodes until navigation or a new snapshot. `snapshot -i` keeps common interactive roles; omit `-i` for a broader tree. Use `frame <selector>` and `frame main` to switch command context. Open shadow controls can use `>>>`; closed shadow controls use snapshot refs.

Supported command families: open/back/forward/reload, snapshot, click/dblclick/hover/fill/type/press/keyboard, select/choose/date/check/uncheck/upload, scroll/scrollintoview/drag, wait/frame, get/is/focus/eval, storage/cookies/dialog/console/errors, set viewport/headers, network requests/route/unroute, and a11y. `choose <field> <query> <exact option>` selects a visible autocomplete result. `date <field> YYYY-MM-DD` operates a visible calendar widget. `drag <source> <target> [auto|before|after|center]` sends a continuous pointer path; `auto` crosses the target midpoint in the movement direction for sortable lists. Network route supports pass-through, `--abort`, or a fixed `--body` response. Console/error collection enables the Runtime event domain only when requested so ordinary sessions keep the smaller CDP surface.

Streaming, secure credentials, gestures, canvas/link export and printing remain Browse-owned CDP features. Recording uses the shared screencast plus FFmpeg; requested FPS samples frames and does not guarantee every frame is new.

### Replacing the original browser entry points

Browse hides BB's original New tab → Open browser action, including its row.
Activation by click or keyboard in the current thread opens Browse's panel.
The Browser action offers a website address field that launches Fortress on the
thread host. Ordinary external web links also open Browse. Modified clicks,
downloads, internal BB routes, and viewer navigation retain their own behavior.

This is a plugin UI override, not removal of BB's browser subsystem. Existing
native tabs and core CLI/API calls remain available, and the DOM selector may
need updating after a BB UI change. Browse does not automatically close existing
native tabs or transfer their cookies. Streaming performance is independent of
which deterministic control layer drives Fortress.

The new-tab page separates this thread's active Sessions from Recent closed
pages (deduplicated by URL, eight entries). Local servers are host-wide web apps
on the thread's current machine, discovered with `ss` on Linux or `lsof` on macOS
and a bounded HTTP HEAD check. They refresh every 15 seconds while the launcher
is open. HTTPS-only apps and servers that reject HEAD may not appear; an address
can still be entered manually. This list does not include every running process.

Browsers belonging to an actively working agent thread, active jobs, recordings, and pending secure login prompts are protected from idle shutdown. Profiles and artifacts survive expiry; unsaved page state does not.

Closing a persisted Browse session tab stops its managed Fortress within a few seconds. Switching tabs or reloading BB does not remove the persisted tab and does not close the session. The blank launcher is not a session.


## Interactive viewer performance

The viewer is passive until its browser surface is hovered or keyboard-focused and the user selects **Take control**. That acquires one authenticated, session-bound control lease and blocks new agent actions and credential requests. An action already running finishes before the handoff completes. One minute without browser input, hiding or closing the viewer, and connection loss all release held keys/buttons and return ownership to the agent. A second viewer cannot take the same session concurrently. Human input then uses direct CDP on the host, bypassing agent job creation and polling. Each input batch is bounded and ordered; pointer moves and compatible wheel events coalesce, and a heartbeat supports long holds.

The binary frame stream allows at most three unacknowledged frames and 4 MiB of unacknowledged JPEG payload. A single frame above 4 MiB is rejected. The server can temporarily retain one additional bounded frame while waiting for byte credit. The client decodes one frame at a time and retains only the newest pending frame. It draws on animation frames and closes decoded image bitmaps. The canvas allocation follows the encoded image size (capture capped at 1920 × 1080), while input coordinates use the actual browser viewport.

Managed Linux sessions use the H.264 video path while a viewer is visible, with the bounded adaptive JPEG transport as an automatic compatibility fallback. Hidden documents and panels close both video and input connections, so an unwatched session does not keep an encoder running. Resuming starts the same viewer transport again without changing the browser profile. The normal idle/session lifetime still applies, and viewing alone does not renew it. Console history retains at most 100 bounded entries; request history retains 200 URLs capped at 8192 characters. These limits are not a total Chromium memory limit.

The authenticated `/viewer-metrics?id=<session-id>` endpoint reports recent viewer samples: displayed FPS, JPEG throughput, input acknowledgement time and dropped frames. Samples expire after 15 seconds, are capped at 32 clients per session, and are removed on release. The host field identifies the BB origin used by that viewer, so localhost measurements can be distinguished from public-client observations. No page text or credentials are included.

Run `node tests/live-viewer.mjs <fixture-profile-id> <viewer-profile-id-or-CDP-port> [soak-seconds]` only with disposable test sessions. It requires the fixture at `http://127.0.0.1:39114/` and the matching local authenticated viewer. It changes the test page and sends synthetic viewer input. Real pointer capture, operating-system clipboard permissions and WAN performance require separate interactive checks.

### Client link routing

Ordinary HTTP(S) links in the selected thread open in Browse; an already visible managed session is reused. Same-origin Browse viewer links resolve their session instead of loading a nested viewer, and reject cross-thread session targets. Command/Ctrl-click and the toolbar's **Open externally** arrow use the current client's `bbDesktop.openExternalUrl` bridge when available, or a new web-client tab. They never launch a browser on the execution server. External browsing uses the device's own cookies, not the managed profile's login. App routes, files, downloads, alternate frame targets, Alt/Shift clicks, and explicitly excluded controls retain their original handling. This is a scoped DOM interceptor plus a desktop bridge, not a public SDK URL-provider replacement; BB updates require regression checks.
