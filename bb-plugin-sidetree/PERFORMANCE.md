# Sidetree performance verification — 2026-09-17

Only `/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree` was changed. The first
command confirmed that this is the installed permanent source. Plugin ID remains
`sidetree`. Production changes, tests, dependency declarations, and
`package-lock.json` are committed. No BB core or other plugin source was changed.

## Measured before / after

Live checks used Browse/Fortress against the running BB frontend, with a
1280 × 800 viewport and the Dusk theme. Temporary fixtures were created inside
Sidetree, then removed. These are individual measurements, not a controlled
cross-device benchmark. DOM counts include side-panel chrome.

| Check | Before | After |
| --- | --- | --- |
| Changed text-file poll | Editor replaced; focus lost; scroll 4000 → 0 | Same editor; focus retained; scroll stayed 4000; zero editor removals |
| Unchanged poll | Already avoided remounting, but transmitted the file again | No editor update; unchanged RPC response was 25 bytes versus 25,227 bytes for the full fixture |
| 10,000-file directory | 10,030 file links; 120,453 side-panel DOM nodes | 34 mounted tree rows; 463 side-panel DOM nodes in the initial sample |
| Large-tree long tasks | 2,049 ms and 6,604 ms | Largest tasks in the measured opening interval were 85 ms and 102 ms; populated tree detected 437 ms after probe start |
| Scroll near final file | Full directory remained mounted | `file-09999.txt` reachable with 43 rows mounted, including overscan and the focused row |
| Sort 10,000 permuted names | 589 ms using `localeCompare` with options for each comparison | 10 ms using one `Intl.Collator`, with the same ordering semantics |
| CodeMirror external append | Whole-document replacement maps an unchanged caret from position 4 to 0, independent of the remount | Minimal text change preserves position 4 in the regression test |
| Markdown external append | Changed-file application remounted the editor | Same editor and first paragraph node; focus retained; selection stayed 30; scroll stayed 1000 |
| Typing and autosave | Save during further typing left the old clean baseline behind | 100 live edit transactions took 237 ms total; all were autosaved; same editor and focus; no removals |
| Large Markdown | Rich editor had no size-based source fallback | 660,000 characters opened as source; 67 rendered CodeMirror lines; ready 755 ms after probe start |
| Image decoding | No reserved image dimensions | 1 × 1 PNG decoded in a reserved 447 × 686 preview area; no text editor |

Probe-to-ready timings include browser automation overhead and BB activity.
They are not isolated render or input-latency measurements. The long-task
observer covered the browser page, not just Sidetree.

## Reproduction findings

The original editor files were temporarily restored from the commit preceding
`9efd82b`, tested, and restored in a `finally` block. Seven of ten editor regression
cases failed on the original code and passed with the changes: changed polls,
save/poll ordering and saved baseline, rapid path changes, direct CodeMirror path
reconfiguration, failed-poll recovery, CRLF saves, and Markdown false-dirty state.
The original FilesPanel also failed the thread-switch test: thread B continued to
show thread A's cached file. The workspace-error test reproduced removal of the
scroll container before the final recovery fix.

Several initial suspicions needed narrowing:

- Unchanged 1.5-second polls already checked hashes and did **not** remount editors.
  Changed polls and explicit reloads did. Saves did **not** increment the revision.
- Search already retained previous results during subsequent requests. The initial
  debounce rendered “No matching files” before a response. It now reserves loading
  rows until the first result.
- Ref objects are stable dependencies. The actual fade-observer lifecycle problem
  was replacing the scroller on a workspace error. The scroller now remains mounted.
- Three initial CodeMirror reconfiguration dispatches were redundant work; they
  were not evidence of three separately painted frames. Configuration now starts
  in the initial state, with later changes batched before paint.

Additional findings fixed:

- Delayed loads could populate a different path. File-session identity and operation
  versions now reject stale results.
- A poll started before a save could arrive after that save. Saves invalidate those
  reads; backend overlapping-read entries are also invalidated around mutations.
- The clean baseline now advances when a save finishes during further typing,
  without replacing the newer draft.
- Markdown selection-only serialization could drop a trailing newline and mark an
  unchanged document dirty. Canonical serialization comparisons prevent this.
- Full Markdown `setContent` has been replaced by a ProseMirror fragment change;
  unchanged nodes and mapped selection survive.
- Same-name theme replacements could retrieve stale cached colors. Theme extensions
  are now cached by theme-object identity in a WeakMap; reset to the default theme
  also reconfigures the editor.
- Missing `--font-mono` invalidated the previous font-family declaration. The fallback
  is now inside `var()`. Live Dusk used Geist Mono in the CodeMirror scroller.
- CRLF buffers could compare against an inconsistent baseline. Editing and saving
  preserve CRLF; dirty comparisons use normalized document lines.
- Global save shortcuts could reach multiple mounted openers. The fallback handler
  now requires focus inside its opener and respects already-handled events.
- Poll application and saves defer while an IME composition is active.
- Initial read failures no longer mount an empty editor; Retry recovers. Failed
  background reads preserve the document and display the error. A live disk deletion
  and restoration retained the editor and recovered on the next successful poll.

## Validation

- `npm ci --include=dev`: succeeded; audit reported zero vulnerabilities.
- `npm run typecheck`: succeeded.
- `npm test`: 27 Node tests and 18 SDK/DOM tests passed, including `tree.test.ts`
  and `file-sync.test.ts`.
- SDK backend harness verified in-flight read deduplication and null unchanged-poll
  responses. It retains no completed file-content cache.
- DOM tests cover forced same-prop reload, stale reads, rapid path changes, save
  during typing/polling, five-second autosave debounce, offline recovery, initial
  Retry, CRLF, binary/image routing, Markdown node preservation and source toggles,
  large Markdown, theme changes/reset, large-tree windowing and keyboard navigation,
  thread cache isolation, and workspace recovery without replacing the scroller.
- `bb plugin build bb-plugin-sidetree` and `bb plugin reload sidetree`: succeeded.
- Live checks additionally covered empty directories/files, binary content in a
  claimed text extension, image decoding, reaching file 9,999, wrap toggles,
  Markdown source/pretty toggles, and saved fixture contents on disk.
- Installed-source checks confirmed Sidetree and the other repository plugins
  running from their permanent paths. No other plugin was rebuilt or reloaded.

Theme replacement/reset was exercised with real CodeMirror in the DOM harness,
using the SDK theme hook as the input boundary. Live BB checks used the existing
Dusk theme; the user's global theme setting was not changed. Screenshot/pixel
comparisons across every theme/device were not performed. The live editor checks
observed DOM identity, focus, selection, scroll, content, and removal counts;
these establish the reproduced flicker fixes, not a universal zero-flicker claim.

## Changed files and review locations

| File | Change |
| --- | --- |
| [app.tsx:119](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/app.tsx:119) | Flattened/windowed tree, bounded requests and collapsed cache, stable focused rows, directory refresh |
| [app.tsx:422](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/app.tsx:422) | Thread/environment isolation, search loading state, persistent scroller during recovery |
| [tree-model.ts:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/tree-model.ts:1) | Iterative flattening, reserved loading rows, visible range, cache eviction |
| [tree.ts:39](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/tree.ts:39) | Reuse the sorting collator |
| [opener.tsx:211](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/opener.tsx:211) | Stable file identity; revision is an update prop, not an editor key; retry and large-Markdown handling |
| [opener.tsx:361](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/opener.tsx:361) | Conditional polls, operation ordering, conflict/offline recovery |
| [opener.tsx:476](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/opener.tsx:476) | Concurrent-save baseline, focused save shortcut, IME guards, reserved status/image space |
| [code-editor.tsx:148](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/code-editor.tsx:148) | Single EditorView, in-place minimal changes, CRLF, baseline and pre-paint configuration |
| [file-sync.ts:14](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/file-sync.ts:14) | Minimal contiguous text replacement with surrogate-pair boundaries |
| [markdown-editor.tsx:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/markdown-editor.tsx:1) | Revision propagation and composition tracking |
| [editor.tsx:514](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/components/ui/editor/editor.tsx:514) | Canonical serialization and fragment-based document synchronization |
| [editor-theme.ts:152](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/editor-theme.ts:152) | Font fallback and identity-based theme cache |
| [scroll-fade.tsx:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/scroll-fade.tsx:1) | Layout-effect measurement, stable overlay nodes, subpixel hysteresis |
| [server.ts:165](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/server.ts:165) | In-flight reads and unchanged `poll_file` response |
| [editor.ui.test.tsx:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/editor.ui.test.tsx:1), [tree.ui.test.tsx:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/tree.ui.test.tsx:1), [server.backend.test.ts:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/server.backend.test.ts:1) | SDK/DOM regression tests |
| [file-sync.test.ts:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/file-sync.test.ts:1), [tree-model.test.ts:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/tree-model.test.ts:1), [editor-theme.test.ts:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/editor-theme.test.ts:1) | Pure regression tests |
| [test-setup.ts:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/test-setup.ts:1), [vitest.config.ts:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/vitest.config.ts:1) | Test runtime and deterministic observer setup |
| [package.json:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/package.json:1), [package-lock.json:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/package-lock.json:1) | Test runner and locked development dependencies |
| [README.md:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/README.md:1), [PERFORMANCE.md:1](/home/g4f4r0/projects/bb-plugins/bb-plugin-sidetree/PERFORMANCE.md:1) | Operating behavior, validation commands and evidence |

## Deliberate limits

The SDK still reads and hashes the whole file on its host for a poll. The browser
saves bandwidth for unchanged content, but host I/O is not eliminated. Trees retain
expanded working data; the 128-directory / 50,000-entry eviction thresholds apply
to collapsed cache entries, not an absolute cap on an arbitrarily large expanded
working set. Markdown above 500,000 characters opens in source mode. Switching
between rich Markdown and source creates the editor for that mode while carrying
the draft. All testing was on the available Linux host and one browser viewport;
real mobile input, IME devices, and every possible file format remain outside the
live test sample.
