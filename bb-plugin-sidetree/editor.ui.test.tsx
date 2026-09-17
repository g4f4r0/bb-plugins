import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("@get-bb/plugin-sdk/app", { spy: true });

import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { EditorView } from "@codemirror/view";
import { FileOpener } from "./opener";
import { CodeEditor } from "./code-editor";

const source = {
  kind: "workspace" as const,
  environmentId: "env_test",
  threadId: "thr_test",
};
const snapshot = (content: string) => ({
  content,
  sha256: content,
  encoding: "utf8",
  mimeType: "text/plain",
  image: false,
  text: true,
  sizeBytes: content.length,
});
const view = (slot: { container: HTMLElement }) =>
  EditorView.findFromDOM(slot.container.querySelector(".cm-editor")!)!;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("disk updates and forced reload keep the editor, caret, focus and scroll", async () => {
  vi.useFakeTimers();
  let disk = "abc def ghi";
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.txt", source },
    {
      rpc: { read_file: () => snapshot(disk), poll_file: () => snapshot(disk) },
    },
  );
  await act(async () => {});
  expect(slot.container.querySelector(".cm-editor")).toBeTruthy();
  const editor = view(slot);
  act(() => {
    editor.dispatch({ selection: { anchor: 4 } });
    editor.focus();
    editor.scrollDOM.scrollTop = 120;
  });
  disk += "!";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(editor.state.doc.toString()).toBe(disk);
  expect(view(slot)).toBe(editor);
  expect(editor.state.selection.main.head).toBe(4);
  expect(editor.hasFocus).toBe(true);
  expect(editor.scrollDOM.scrollTop).toBe(120);
  act(() => editor.dispatch({ changes: { from: 0, insert: "local" } }));
  disk += "?";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(slot.getByRole("alert").textContent).toContain("changed on disk");
  fireEvent.click(slot.getByText("Reload", { selector: "button" }));
  await act(async () => {});
  expect(view(slot)).toBe(editor);
  expect(editor.state.doc.toString()).toBe(disk);
});

test("save during poll discards old reads; typing during save advances clean baseline only", async () => {
  vi.useFakeTimers();
  const read = deferred<ReturnType<typeof snapshot>>();
  const write = deferred<{ outcome: string; sha256: string }>();
  let reads = 0;
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.txt", source },
    {
      rpc: {
        read_file: () => {
          reads++;
          return snapshot("abc");
        },
        poll_file: () => {
          reads++;
          return read.promise;
        },
        write_file: () => write.promise,
      },
    },
  );
  await act(async () => {});
  expect(slot.container.querySelector(".cm-editor")).toBeTruthy();
  const editor = view(slot);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(reads).toBeGreaterThan(1);
  act(() => {
    editor.dispatch({ changes: { from: 3, insert: "d" } });
    editor.focus();
  });
  fireEvent.keyDown(editor.contentDOM, { key: "s", ctrlKey: true });
  act(() => editor.dispatch({ changes: { from: 4, insert: "e" } }));
  await act(async () => write.resolve({ outcome: "written", sha256: "abcd" }));
  await act(async () => read.resolve(snapshot("abc")));
  expect(editor.state.doc.toString()).toBe("abcde");
  expect(slot.queryByRole("alert")).toBeNull();
  expect(slot.getByLabelText("Unsaved changes")).toBeTruthy();
  act(() => editor.dispatch({ changes: { from: 4, to: 5 } }));
  expect(slot.queryByLabelText("Unsaved changes")).toBeNull();
});

test("rapid file changes ignore a previous path's delayed load", async () => {
  const old = deferred<ReturnType<typeof snapshot>>();
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.txt", source },
    {
      rpc: {
        read_file: (target: { path: string }) =>
          target.path === "a.txt" ? old.promise : snapshot("new file"),
      },
    },
  );
  slot.rerender(<FileOpener path="b.txt" source={source} />);
  await waitFor(() =>
    expect(slot.container.querySelector(".cm-editor")).toBeTruthy(),
  );
  await act(async () => old.resolve(snapshot("old file")));
  expect(view(slot).state.doc.toString()).toBe("new file");
});

test("wrap/read-only/path updates keep one CodeMirror view", () => {
  const slot = renderSlot(
    { component: CodeEditor },
    { path: "a.txt", value: "abc", readOnly: false },
  );
  const editor = view(slot);
  slot.rerender(<CodeEditor path="b.ts" value="abc" readOnly wrap />);
  expect(view(slot)).toBe(editor);
  expect(editor.state.readOnly).toBe(true);
  expect(editor.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
});

test("offline/deleted-file polls retain dirty text and recover without remount", async () => {
  vi.useFakeTimers();
  let offline = true;
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.txt", source },
    {
      rpc: {
        read_file: () => snapshot("abc"),
        poll_file: () => {
          if (offline) throw new Error("File missing or host offline");
          return null;
        },
      },
    },
  );
  await act(async () => {});
  const editor = view(slot);
  act(() => editor.dispatch({ changes: { from: 3, insert: "d" } }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(slot.getByRole("alert").textContent).toContain("Unable to refresh");
  expect(editor.state.doc.toString()).toBe("abcd");
  offline = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(slot.queryByRole("alert")).toBeNull();
  expect(view(slot)).toBe(editor);
});

test("5s autosave debounces typing and saves only the latest document", async () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.txt", source },
    {
      rpc: {
        read_file: () => snapshot("a"),
        poll_file: () => null,
        write_file: ({ content }: { content: string }) => {
          writes.push(content);
          return { outcome: "written", sha256: content };
        },
      },
    },
  );
  await act(async () => {});
  const editor = view(slot);
  act(() => editor.dispatch({ changes: { from: 1, insert: "b" } }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4900);
  });
  expect(writes).toEqual([]);
  act(() => editor.dispatch({ changes: { from: 2, insert: "c" } }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4900);
  });
  expect(writes).toEqual([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(writes).toEqual(["abc"]);
  expect(view(slot)).toBe(editor);
  expect(slot.queryByLabelText("Unsaved changes")).toBeNull();
});

test("CRLF stays clean and is preserved when editing and saving", async () => {
  let written = "";
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.txt", source },
    {
      rpc: {
        read_file: () => snapshot("a\r\nb"),
        poll_file: () => null,
        write_file: ({ content }: { content: string }) => {
          written = content;
          return { outcome: "written", sha256: content };
        },
      },
    },
  );
  await act(async () => {});
  expect(slot.queryByLabelText("Unsaved changes")).toBeNull();
  const editor = view(slot);
  act(() => {
    editor.dispatch({ changes: { from: 3, insert: "c" } });
    editor.focus();
  });
  fireEvent.keyDown(editor.contentDOM, { key: "s", ctrlKey: true });
  await act(async () => {});
  expect(written).toBe("a\r\nbc");
  expect(slot.queryByLabelText("Unsaved changes")).toBeNull();
});

test("binary and image files do not mount text editors", async () => {
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.bin", source },
    {
      rpc: {
        read_file: (target: { path: string }) => ({
          ...snapshot("AA=="),
          encoding: "base64",
          text: false,
          image: target.path.endsWith("png"),
        }),
      },
    },
  );
  await act(async () => {});
  expect(slot.container.querySelector(".cm-editor")).toBeNull();
  expect(slot.getByText("Binary file · a.bin")).toBeTruthy();
  slot.rerender(<FileOpener path="a.png" source={source} />);
  await act(async () => {});
  expect(slot.getByAltText("a.png").getAttribute("src")).toContain(
    "base64,AA==",
  );
  expect(slot.container.querySelector(".cm-editor")).toBeNull();
});

import type { Editor as TiptapEditor } from "@tiptap/core";
const markdownView = (slot: { container: HTMLElement }) =>
  (
    slot.container.querySelector(".ProseMirror") as HTMLElement & {
      editor: TiptapEditor;
    }
  ).editor;

test("Markdown polls patch only changed content and preserve editor, selection, focus", async () => {
  vi.useFakeTimers();
  let disk = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.md", source },
    {
      rpc: { read_file: () => snapshot(disk), poll_file: () => snapshot(disk) },
    },
  );
  await act(async () => {});
  const editor = markdownView(slot);
  const paragraph = editor.view.dom.querySelector("p");
  act(() => {
    editor.commands.setTextSelection(10);
    editor.view.focus();
  });
  expect(slot.queryByLabelText("Unsaved changes")).toBeNull();
  disk += "\nAppended paragraph.\n";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(markdownView(slot)).toBe(editor);
  expect(editor.view.dom.querySelector("p")).toBe(paragraph);
  expect(editor.state.selection.from).toBe(10);
  expect(editor.view.hasFocus()).toBe(true);
  expect(editor.getMarkdown()).toContain("Appended paragraph.");
});

test("Markdown source toggles carry unsaved edits through both editors", async () => {
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.md", source },
    { rpc: { read_file: () => snapshot("# Title\n"), poll_file: () => null } },
  );
  await act(async () => {});
  const markdown = markdownView(slot);
  act(() => {
    markdown.commands.insertContentAt(
      markdown.state.doc.content.size,
      "<p>Local text</p>",
    );
  });
  fireEvent.click(slot.getByLabelText("Code"));
  expect(view(slot).state.doc.toString()).toContain("Local text");
  act(() => {
    const editor = view(slot);
    editor.dispatch({
      changes: { from: editor.state.doc.length, insert: "\n\nMore text" },
    });
  });
  fireEvent.click(slot.getByLabelText("Code"));
  await act(async () => {});
  expect(markdownView(slot).getMarkdown()).toContain("More text");
  expect(slot.getByLabelText("Unsaved changes")).toBeTruthy();
});

test("Reload discards edits even when the disk value equals the previous draft prop", async () => {
  vi.useFakeTimers();
  let disk = "abc";
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.txt", source },
    {
      rpc: { read_file: () => snapshot(disk), poll_file: () => snapshot(disk) },
    },
  );
  await act(async () => {});
  const editor = view(slot);
  act(() => editor.dispatch({ changes: { from: 3, insert: "local" } }));
  disk = "external";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  disk = "abc";
  fireEvent.click(slot.getByText("Reload", { selector: "button" }));
  await act(async () => {});
  expect(view(slot)).toBe(editor);
  expect(editor.state.doc.toString()).toBe("abc");
  expect(slot.queryByLabelText("Unsaved changes")).toBeNull();
});

test("initial read failure can be retried without mounting an empty editor", async () => {
  let offline = true;
  const slot = renderSlot(
    { component: FileOpener },
    { path: "a.txt", source },
    {
      rpc: {
        read_file: () => {
          if (offline) throw new Error("offline");
          return snapshot("recovered");
        },
      },
    },
  );
  await act(async () => {});
  expect(slot.container.querySelector(".cm-editor")).toBeNull();
  expect(slot.getByText("File unavailable.")).toBeTruthy();
  offline = false;
  fireEvent.click(slot.getByText("Retry", { selector: "button" }));
  await act(async () => {});
  expect(view(slot).state.doc.toString()).toBe("recovered");
});

test("large Markdown opens in virtualized CodeMirror and remains editable", async () => {
  const content = "# Heading\n\n".repeat(60_000);
  const slot = renderSlot(
    { component: FileOpener },
    { path: "huge.md", source },
    { rpc: { read_file: () => snapshot(content), poll_file: () => null } },
  );
  await act(async () => {});
  const editor = view(slot);
  expect(editor.state.doc.length).toBe(content.length);
  expect(slot.container.querySelector(".ProseMirror")).toBeNull();
  act(() => editor.dispatch({ changes: { from: 0, insert: "x" } }));
  expect(editor.state.doc.sliceString(0, 1)).toBe("x");
  expect(slot.getByLabelText("Unsaved changes")).toBeTruthy();
});

import * as appSdk from "@get-bb/plugin-sdk/app";

test("live code theme changes, same-name replacements, and reset preserve the view", () => {
  const theme = {
    name: "test",
    type: "dark" as const,
    bg: "#112233",
    fg: "#eeeeee",
    colors: {},
    tokenColors: [],
  };
  const hook = vi
    .spyOn(appSdk, "experimental_useCodeTheme")
    .mockReturnValue({ mode: "dark", name: "test", theme });
  try {
    const slot = renderSlot(
      { component: CodeEditor },
      { path: "a.txt", value: "abc", readOnly: false },
    );
    const editor = view(slot);
    expect(editor.state.facet(EditorView.darkTheme)).toBe(true);
    hook.mockReturnValue({
      mode: "light",
      name: "test",
      theme: { ...theme, type: "light", bg: "#aabbcc" },
    });
    slot.rerender(
      <CodeEditor path="a.txt" value="abc" readOnly={false} wrap />,
    );
    expect(view(slot)).toBe(editor);
    expect(editor.state.facet(EditorView.darkTheme)).toBe(false);
    hook.mockReturnValue({ mode: "light", name: "default", theme: null });
    slot.rerender(<CodeEditor path="a.txt" value="abc" readOnly={false} />);
    expect(view(slot)).toBe(editor);
    expect(editor.state.facet(EditorView.darkTheme)).toBe(false);
  } finally {
    hook.mockRestore();
  }
});
