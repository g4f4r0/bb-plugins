import {
  memo,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import {
  Compartment,
  EditorState,
  Prec,
  Text,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { textChange } from "./file-sync";
import { languageForPath } from "./editor-language";
import {
  codeMirrorTheme,
  editorChrome,
  editorSurface,
  selectionForeground,
} from "./editor-theme";
import { ScrollEdgeFades, watchOverflowEdges } from "./scroll-fade";
import { useSelectionAddToChat } from "./selection-add-to-chat";

function setup() {
  return [
    editorChrome,
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    selectionForeground,
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    keymap.of([
      indentWithTab,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
    ]),
  ];
}

export type CodeEditorHandle = {
  getDoc(): string;
  blur(): void;
  isComposing?(): boolean;
};

export const CodeEditor = memo(function CodeEditor({
  path,
  value,
  cleanValue,
  revision = 0,
  onDirty,
  onSave,
  readOnly,
  wrap = false,
  startLine,
  endLine,
  editorRef,
}: {
  path: string;
  value: string;
  cleanValue?: string;
  revision?: number;
  onDirty?: (dirty: boolean) => void;
  onSave?: () => void;
  readOnly: boolean;
  wrap?: boolean;
  startLine?: number | null;
  endLine?: number | null;
  editorRef?: Ref<CodeEditorHandle | null>;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const skipSelectionMenu = useRef(false);
  const language = useRef(new Compartment());
  const theme = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const baseline = useRef(Text.empty);
  const applying = useRef(false);
  const valueRef = useRef(value);
  const cleanValueRef = useRef(cleanValue);
  const onDirtyRef = useRef(onDirty);
  const onSaveRef = useRef(onSave);
  valueRef.current = value;
  cleanValueRef.current = cleanValue;
  onDirtyRef.current = onDirty;
  onSaveRef.current = onSave;
  const codeTheme = experimental_useCodeTheme();
  const configuration = useRef({
    path,
    theme: codeTheme.theme,
    readOnly,
    wrap,
  });
  const surface =
    codeTheme.theme === null
      ? "var(--background)"
      : editorSurface(codeTheme.theme);
  const [edges, setEdges] = useState({ above: false, below: false });
  const { menu } = useSelectionAddToChat({
    containerRef: parent,
    viewRef,
    path,
    skipRef: skipSelectionMenu,
  });

  useImperativeHandle(editorRef, () => ({
    getDoc() {
      return viewRef.current?.state.sliceDoc() ?? valueRef.current;
    },
    blur() {
      viewRef.current?.contentDOM.blur();
    },
    isComposing() {
      return viewRef.current?.composing ?? false;
    },
  }));

  useLayoutEffect(() => {
    const node = parent.current;
    if (node === null) return;
    setEdges({ above: false, below: false });
    let schedule = () => {};
    const view = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: Text.of(value.split(/\r\n?|\n/)),
        extensions: [
          setup(),
          EditorState.lineSeparator.of(value.includes("\r\n") ? "\r\n" : "\n"),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  onSaveRef.current?.();
                  return true;
                },
              },
            ]),
          ),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []),
          language.current.of(languageForPath(path)),
          theme.current.of(
            codeTheme.theme !== null
              ? codeMirrorTheme(codeTheme.theme)
              : syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          ),
          editable.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applying.current) {
              onDirtyRef.current?.(!update.state.doc.eq(baseline.current));
            }
            if (update.docChanged || update.heightChanged) schedule();
          }),
        ],
      }),
    });
    viewRef.current = view;
    baseline.current = EditorState.create({ doc: cleanValue ?? value }).doc;
    const watch = watchOverflowEdges(view.scrollDOM, setEdges);
    schedule = watch.schedule;
    return () => {
      watch.disconnect();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const previous = view.state.doc.toString();
    const normalized = value.replace(/\r\n?/g, "\n");
    if (previous === normalized) return;
    const scrollTop = view.scrollDOM.scrollTop;
    const scrollLeft = view.scrollDOM.scrollLeft;
    applying.current = true;
    try {
      const change = textChange(previous, normalized);
      view.dispatch({
        changes: { ...change, insert: Text.of(change.insert.split("\n")) },
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      applying.current = false;
    }
    view.scrollDOM.scrollTop = scrollTop;
    view.scrollDOM.scrollLeft = scrollLeft;
  }, [value, revision]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    baseline.current = Text.of((cleanValue ?? value).split(/\r\n?|\n/));
    onDirtyRef.current?.(!view.state.doc.eq(baseline.current));
  }, [cleanValue, value, revision]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const previous = configuration.current;
    const effects = [];
    if (previous.path !== path)
      effects.push(language.current.reconfigure(languageForPath(path)));
    if (previous.theme !== codeTheme.theme)
      effects.push(
        theme.current.reconfigure(
          codeTheme.theme === null
            ? syntaxHighlighting(defaultHighlightStyle, { fallback: true })
            : codeMirrorTheme(codeTheme.theme),
        ),
      );
    if (previous.readOnly !== readOnly)
      effects.push(
        editable.current.reconfigure(EditorState.readOnly.of(readOnly)),
      );
    if (previous.wrap !== wrap)
      effects.push(
        wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
      );
    configuration.current = { path, theme: codeTheme.theme, readOnly, wrap };
    if (effects.length) view.dispatch({ effects });
  }, [path, codeTheme.theme, readOnly, wrap]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null || startLine == null) return;
    const doc = view.state.doc;
    const fromLine = Math.min(Math.max(startLine, 1), doc.lines);
    const toLine = Math.min(
      Math.max(endLine ?? startLine, fromLine),
      doc.lines,
    );
    const start = doc.line(fromLine);
    const end = doc.line(toLine);
    const sel = view.state.selection.main;
    if (sel.from === start.from && sel.to === end.to) return;
    skipSelectionMenu.current = true;
    view.dispatch({
      selection: { anchor: start.from, head: end.to },
      scrollIntoView: true,
    });
  }, [path, startLine, endLine]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden px-4">
      <div ref={parent} className="h-full min-h-0 overflow-hidden" />
      {menu}
      <ScrollEdgeFades
        above={edges.above}
        below={edges.below}
        color={surface}
      />
    </div>
  );
});
