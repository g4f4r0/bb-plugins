# Sidetree

A file tree in the thread side panel. The tab is Files.

```
npm ci --include=dev
npm run typecheck
npm test
# From /home/g4f4r0/projects/bb-plugins:
bb plugin build bb-plugin-sidetree
bb plugin reload sidetree
```

In a thread, + then Open files. Click a folder to expand it. Click a file to
open it. That tab is titled Editor. The ⋮ menu copies, downloads, and deletes.
Cmd/Ctrl+S saves; typing also autosaves after five idle seconds.

Most text files open in CodeMirror. `.md` and `.markdown` open as a page you
edit. Toggle Code for the source. `.mdx` stays in CodeMirror. Select text
and add it to chat. Colors come from BB's code theme.

Type / for a command. Image asks for a URL. Headings, lists, and tables are
in that list too. Sidetree does not put image files in the markdown.

```
bb plugin reload sidetree
```

Reopen the file tab after a reload. The old tab still has the previous bundle.

## Performance and synchronization

The tree renders the viewport plus eight rows of overscan on either side.
Arrow keys, Home, and End navigate offscreen rows. Focused rows stay mounted.
Visible expanded directories refresh every ten seconds, with at most four
requests in flight. Collapsed-directory cache entries are evicted above 128
directories or 50,000 entries; the visible working set is retained. Thread and
environment changes get separate tree state.

Visible file tabs poll every 1.5 seconds after the previous request finishes.
Unchanged responses omit file contents; overlapping reads are shared only
while pending. The SDK still reads and hashes on the host. Changed text patches
the existing editor and preserves selections in unchanged content. Local edits
produce a conflict instead of being overwritten. Offline/deleted-file errors
retain the last editable document. Failed initial opens offer Retry.

Markdown larger than 500,000 characters opens as source to bound DOM size.
CodeMirror preserves CRLF line endings. Source/pretty toggles preserve the draft;
each mode creates its own editor. Fades and save indicators retain their layout
space, and images occupy a fixed preview area while decoding.

## Layout

- `server.ts` lists one directory under the thread workspace.
- `app.tsx` is the Files tab. Files are `FileLink`s.
- `opener.tsx` is the file tab, markdown or CodeMirror, and the ⋮ menu.
- `markdown-editor.tsx` is the TipTap page for `.md` / `.markdown`.
- `code-editor.tsx` is CodeMirror 6, themed from BB's code theme.
- `tree.ts` keeps paths inside the workspace. The test uses it too.
