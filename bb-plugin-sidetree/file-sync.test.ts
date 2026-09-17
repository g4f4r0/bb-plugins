import assert from "node:assert/strict";
import test from "node:test";
import { fileSyncAction } from "./file-sync.ts";

test("same hash is a no-op", () => {
  assert.equal(fileSyncAction("aaa", "aaa", false), "same");
  assert.equal(fileSyncAction("aaa", "aaa", true), "same");
});

test("no current hash is a no-op until the first load", () => {
  assert.equal(fileSyncAction(null, "bbb", false), "same");
});

test("clean buffer reloads when disk changes", () => {
  assert.equal(fileSyncAction("aaa", "bbb", false), "reload");
});

test("dirty buffer does not clobber local edits", () => {
  assert.equal(fileSyncAction("aaa", "bbb", true), "conflict");
});

import { textChange } from "./file-sync.ts";
import { EditorState } from "@codemirror/state";

test("external append preserves caret in unchanged text", () => {
  const state = EditorState.create({
    doc: "abc def ghi",
    selection: { anchor: 4 },
  });
  const next = state.update({
    changes: textChange(state.doc.toString(), "abc def ghi!"),
  }).state;
  assert.equal(next.selection.main.head, 4);
  assert.equal(next.doc.toString(), "abc def ghi!");
});

test("minimal text changes handle empty, unicode, CRLF and arbitrary replacements", () => {
  const texts = [
    "",
    "abc",
    "ab",
    "😀 first",
    "😁 first",
    "a\r\nb",
    "\n",
    "a".repeat(100_000),
  ];
  for (const before of texts)
    for (const after of texts) {
      const change = textChange(before, after);
      assert.equal(
        before.slice(0, change.from) + change.insert + before.slice(change.to),
        after,
      );
    }
});
