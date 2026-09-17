import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t, type Tag } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";

const SCOPE_TAGS: readonly { scope: string; tag: Tag | readonly Tag[] }[] = [
  { scope: "comment.line", tag: t.lineComment },
  { scope: "comment.block", tag: t.blockComment },
  { scope: "comment", tag: t.comment },
  { scope: "string.regexp", tag: t.regexp },
  { scope: "string", tag: t.string },
  { scope: "constant.numeric", tag: t.number },
  { scope: "constant.language.boolean", tag: t.bool },
  { scope: "constant.character.escape", tag: t.escape },
  { scope: "constant.language", tag: t.atom },
  { scope: "constant", tag: t.atom },
  { scope: "variable.parameter", tag: t.variableName },
  { scope: "variable.language", tag: t.self },
  { scope: "variable.other.property", tag: t.propertyName },
  { scope: "meta.object-literal.key", tag: t.propertyName },
  { scope: "support.type.property-name", tag: t.propertyName },
  { scope: "variable", tag: t.variableName },
  { scope: "keyword.control.import", tag: t.moduleKeyword },
  { scope: "keyword.control", tag: t.controlKeyword },
  { scope: "keyword.operator", tag: t.operatorKeyword },
  { scope: "keyword", tag: t.keyword },
  { scope: "storage.type", tag: t.definitionKeyword },
  { scope: "storage.modifier", tag: t.modifier },
  { scope: "storage", tag: t.keyword },
  { scope: "entity.name.function", tag: t.function(t.variableName) },
  { scope: "entity.name.function", tag: t.function(t.name) },
  { scope: "entity.name.function", tag: t.function(t.definition(t.variableName)) },
  { scope: "entity.name.function", tag: t.function(t.propertyName) },
  { scope: "entity.name.class", tag: t.className },
  { scope: "entity.name.type", tag: t.typeName },
  { scope: "entity.name.tag", tag: t.tagName },
  { scope: "entity.name.tag", tag: t.standard(t.tagName) },
  { scope: "entity.other.attribute-name", tag: t.attributeName },
  { scope: "entity.name", tag: t.name },
  { scope: "string", tag: t.special(t.string) },
  { scope: "string", tag: t.attributeValue },
  { scope: "support.function", tag: t.standard(t.function(t.variableName)) },
  { scope: "support.class", tag: t.standard(t.className) },
  { scope: "support.type", tag: t.standard(t.typeName) },
  { scope: "punctuation", tag: t.punctuation },
  { scope: "markup.heading", tag: t.heading },
  { scope: "markup.bold", tag: t.strong },
  { scope: "markup.italic", tag: t.emphasis },
  { scope: "markup.strikethrough", tag: t.strikethrough },
  { scope: "markup.quote", tag: t.quote },
  { scope: "markup.underline.link", tag: t.link },
  { scope: "markup.inline.raw", tag: t.monospace },
  { scope: "markup.inserted", tag: t.inserted },
  { scope: "markup.deleted", tag: t.deleted },
  { scope: "markup.changed", tag: t.changed },
  { scope: "invalid", tag: t.invalid },
];

function themeScopeCovers(tmScope: string, themeScope: string): boolean {
  return tmScope === themeScope || tmScope.startsWith(`${themeScope}.`);
}

function styleFromRule(rule: PluginCodeThemeData["tokenColors"][number]): {
  color?: string;
  fontStyle?: string;
  textDecoration?: string;
} {
  const font = rule.settings.fontStyle ?? "";
  return {
    color: rule.settings.foreground,
    fontStyle: font.includes("italic") ? "italic" : undefined,
    textDecoration: font.includes("underline")
      ? "underline"
      : font.includes("strikethrough")
        ? "line-through"
        : undefined,
  };
}

/** VS Code inheritance: a theme rule for `entity` applies to `entity.name.function`. */
export function tokenStyles(
  theme: PluginCodeThemeData,
): Map<Tag | readonly Tag[], { color?: string; fontStyle?: string; textDecoration?: string }> {
  const best = new Map<
    Tag | readonly Tag[],
    { length: number; color?: string; fontStyle?: string; textDecoration?: string }
  >();
  for (const { scope: tmScope, tag } of SCOPE_TAGS) {
    for (const rule of theme.tokenColors) {
      const scopes =
        rule.scope === undefined
          ? []
          : typeof rule.scope === "string"
            ? [rule.scope]
            : [...rule.scope];
      for (const scope of scopes) {
        if (!themeScopeCovers(tmScope, scope)) continue;
        const current = best.get(tag);
        if (current !== undefined && current.length >= scope.length) continue;
        best.set(tag, { length: scope.length, ...styleFromRule(rule) });
      }
    }
  }
  return new Map(
    [...best.entries()].map(([tag, spec]) => [
      tag,
      { color: spec.color, fontStyle: spec.fontStyle, textDecoration: spec.textDecoration },
    ]),
  );
}

function workbench(
  colors: Readonly<Record<string, string>>,
  key: string,
  fallback: string,
): string {
  return colors[key] ?? fallback;
}

export function editorSurface(theme: PluginCodeThemeData): string {
  return workbench(theme.colors, "editor.background", theme.bg);
}

export function editorSelectionPaint(theme: PluginCodeThemeData | null): {
  background: string;
  color: string;
} {
  if (theme === null) {
    return {
      background: "color-mix(in srgb, var(--primary) 40%, transparent)",
      color: "var(--primary)",
    };
  }
  const cursor = workbench(theme.colors, "editorCursor.foreground", theme.fg);
  return {
    background: `color-mix(in srgb, ${cursor} 40%, transparent)`,
    color: workbench(theme.colors, "editor.selectionForeground", cursor),
  };
}

export const editorChrome = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono, ui-monospace), monospace",
    fontSize: "13px",
    fontKerning: "none",
    fontVariantLigatures: "none",
  },
  ".cm-content": { fontFamily: "inherit", fontSize: "inherit" },
  ".cm-gutters": { border: "none", fontFamily: "inherit", fontSize: "inherit" },
});

const selectedMark = Decoration.mark({ class: "cm-selectedText" });

function selectedText(view: EditorView): DecorationSet {
  const ranges = [];
  for (const range of view.state.selection.ranges) {
    if (!range.empty) ranges.push(selectedMark.range(range.from, range.to));
  }
  return Decoration.set(ranges, true);
}

/** Paint selected glyphs one color. CM's selection layer only tints the background. */
export const selectionForeground = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = selectedText(view);
    }
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged || update.viewportChanged) {
        this.decorations = selectedText(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations },
);

const themeCache = new WeakMap<PluginCodeThemeData, Extension>();

export function codeMirrorTheme(theme: PluginCodeThemeData): Extension {
  const cached = themeCache.get(theme);
  if (cached !== undefined) return cached;
  const bg = editorSurface(theme);
  const fg = workbench(theme.colors, "editor.foreground", theme.fg);
  const cursor = workbench(theme.colors, "editorCursor.foreground", fg);
  const selectionFg = workbench(theme.colors, "editor.selectionForeground", cursor);
  const selection = `color-mix(in srgb, ${cursor} 40%, transparent)`;
  const line = workbench(theme.colors, "editor.lineHighlightBackground", "transparent");
  const gutterBg = workbench(theme.colors, "editorGutter.background", bg);
  const gutterFg = workbench(theme.colors, "editorLineNumber.foreground", fg);
  const gutterActive = workbench(
    theme.colors,
    "editorLineNumber.activeForeground",
    fg,
  );
  const match = workbench(theme.colors, "editor.findMatchBackground", selection);
  const widget = workbench(theme.colors, "editorWidget.background", bg);
  const widgetBorder = workbench(theme.colors, "editorWidget.border", fg);

  const highlight = [...tokenStyles(theme).entries()].map(([tag, spec]) => ({
    tag,
    ...spec,
  }));

  const extension = [
    EditorView.theme(
      {
        "&": {
          backgroundColor: bg,
          color: fg,
        },
        "&.cm-focused": { outline: "none" },
        ".cm-content": {
          caretColor: cursor,
        },
        ".cm-content ::selection": {
          backgroundColor: "transparent",
          color: `${selectionFg} !important`,
        },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: cursor },
        ".cm-selectionBackground": { background: selection },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
          background: selection,
        },
        ".cm-selectedText": {
          color: `${selectionFg} !important`,
          WebkitTextFillColor: `${selectionFg} !important`,
        },
        ".cm-selectedText *": {
          color: "inherit !important",
        },
        ".cm-activeLine": { backgroundColor: line },
        ".cm-gutters": {
          backgroundColor: gutterBg,
          color: gutterFg,
        },
        ".cm-activeLineGutter": {
          backgroundColor: line,
          color: gutterActive,
        },
        ".cm-selectionMatch": { backgroundColor: match },
        ".cm-panels": { backgroundColor: widget, color: fg },
        ".cm-panels .cm-panel": { borderTop: `1px solid ${widgetBorder}` },
        ".cm-searchMatch": { backgroundColor: match },
      },
      { dark: theme.type === "dark" },
    ),
    syntaxHighlighting(HighlightStyle.define(highlight)),
  ];
  themeCache.set(theme, extension);
  return extension;
}
