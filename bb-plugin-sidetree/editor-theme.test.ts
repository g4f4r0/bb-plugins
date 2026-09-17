import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tags as t } from "@lezer/highlight";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import { editorSelectionPaint, tokenStyles } from "./editor-theme.ts";

function loadTheme(file: string): PluginCodeThemeData {
  const raw = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../bb-plugin-dusk/themes",
        file,
      ),
      "utf8",
    ),
  ) as {
    name: string;
    type: "dark" | "light";
    colors: Record<string, string>;
    tokenColors: PluginCodeThemeData["tokenColors"];
  };
  return {
    name: raw.name,
    type: raw.type,
    fg: raw.colors["editor.foreground"] ?? "#24292e",
    bg: raw.colors["editor.background"] ?? "#ffffff",
    colors: raw.colors,
    tokenColors: raw.tokenColors,
  };
}

test("Pages CMS github-dark tokens on Dusk sidebar", () => {
  const theme = loadTheme("dusk-dark.json");
  assert.equal(theme.colors["editor.background"], "#0a0a0b");
  const styles = tokenStyles(theme);
  assert.equal(styles.get(t.keyword)?.color, "#f97583");
  assert.equal(styles.get(t.moduleKeyword)?.color, "#f97583");
  assert.equal(styles.get(t.definitionKeyword)?.color, "#f97583");
  assert.equal(styles.get(t.function(t.variableName))?.color, "#b392f0");
  assert.equal(styles.get(t.string)?.color, "#9ecbff");
  assert.equal(styles.get(t.comment)?.color, "#6a737d");
  assert.equal(styles.get(t.attributeName)?.color, "#b392f0");
  assert.equal(styles.get(t.tagName)?.color, "#79b8ff");
  assert.equal(styles.get(t.punctuation)?.color, undefined);
});

test("pretty markdown selection uses the same Dusk wash as CodeMirror", () => {
  const theme = loadTheme("dusk-dark.json");
  const paint = editorSelectionPaint(theme);
  assert.equal(
    paint.background,
    "color-mix(in srgb, #2383e2 40%, transparent)",
  );
  assert.equal(paint.color, "#2383e2");
});

test("Pages CMS github-light tokens on Dusk sidebar", () => {
  const theme = loadTheme("dusk-light.json");
  assert.equal(theme.colors["editor.background"], "#f7f7f5");
  const styles = tokenStyles(theme);
  assert.equal(styles.get(t.keyword)?.color, "#d73a49");
  assert.equal(styles.get(t.moduleKeyword)?.color, "#d73a49");
  assert.equal(styles.get(t.definitionKeyword)?.color, "#d73a49");
  assert.equal(styles.get(t.function(t.variableName))?.color, "#6f42c1");
  assert.equal(styles.get(t.string)?.color, "#032f62");
  assert.equal(styles.get(t.comment)?.color, "#6a737d");
  assert.equal(styles.get(t.attributeName)?.color, "#6f42c1");
  assert.equal(styles.get(t.tagName)?.color, "#005cc5");
  assert.equal(styles.get(t.punctuation)?.color, undefined);
});

import { codeMirrorTheme } from "./editor-theme.ts";

test("same-name theme replacement does not reuse stale colors", () => {
  const first = loadTheme("dusk-dark.json");
  const second = {
    ...first,
    colors: { ...first.colors, "editor.background": "#123456" },
  };
  assert.equal(codeMirrorTheme(first), codeMirrorTheme(first));
  assert.notEqual(codeMirrorTheme(first), codeMirrorTheme(second));
});
