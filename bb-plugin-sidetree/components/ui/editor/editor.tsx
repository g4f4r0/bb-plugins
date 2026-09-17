import { type HTMLAttributes, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Node as TiptapNode, createDocument, mergeAttributes, type Editor as TiptapEditor } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { Markdown } from "@tiptap/markdown";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { cn } from "../../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "../motion.js";
import { Icon, type IconName } from "../icon";
import "./typeset.css";
import SlashCommands from "./slash-command/commands";
import type {
  ImagePickerContext,
  ImagePickerFileResult,
  ImagePickerHandler,
  ImagePickerResult,
  ImagePickerUrlResult,
} from "./slash-command/suggestion";

export type EditorFormat = "html" | "markdown";
export type ImageFallbackMode = "data-url" | "prompt-url" | "none";
export type MarkdownHtmlPolicy = {
  keep?: string[];
  strip?: string[];
  drop?: string[];
};
export type ImageUploadContext = {
  editor: TiptapEditor;
  source: "paste" | "drop" | "slash";
};
export type ImageUploadResult = {
  src: string;
  alt?: string;
  title?: string;
};
export type ImageUploadHandler = (
  file: File,
  context: ImageUploadContext,
) => ImageUploadResult | null | Promise<ImageUploadResult | null>;

const DEFAULT_MAX_IMAGE_BYTES = 1_000_000;
const BUBBLE_PLUGIN_KEY = "editor-bubble";

const isInsertableImageSrc = (src: string): boolean => {
  const trimmed = src.trim();
  return trimmed.length > 0 && !/^(javascript|vbscript):/i.test(trimmed);
};

const UPLOADED_IMAGE_PRELOAD_TIMEOUT_MS = 8_000;

const RAW_MARKDOWN_HTML_BLOCK = "rawMarkdownHtmlBlock";
const RAW_MARKDOWN_HTML_INLINE = "rawMarkdownHtmlInline";
const DROPPED_MARKDOWN_HTML_BLOCK = "droppedMarkdownHtmlBlock";
const DROPPED_MARKDOWN_HTML_INLINE = "droppedMarkdownHtmlInline";

const normalizeMarkdownHtmlSelectors = (selectors: string[] | undefined): string[] =>
  Array.isArray(selectors) ? selectors.map((selector) => selector.trim()).filter(Boolean) : [];

const getMarkdownHtmlRootElement = (html: string): Element | null => {
  if (typeof window === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.firstElementChild;
};

const getMarkdownHtmlTopLevelNodes = (html: string): ChildNode[] => {
  if (typeof window === "undefined") return [];
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return Array.from(template.content.childNodes);
};

const createRawMarkdownHtmlDom = (html: string, fallbackTag: "div" | "span"): HTMLElement => {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const element = template.content.firstElementChild;

  if (element instanceof HTMLElement) {
    return element;
  }

  const fallback = document.createElement(fallbackTag);
  fallback.textContent = html;
  return fallback;
};

const markdownHtmlTextContent = (html: string): string => {
  if (typeof window === "undefined") {
    return html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
};

const createMarkdownHtmlTextNode = (html: string, block?: boolean) => {
  const text = markdownHtmlTextContent(html);
  if (!text) return createDroppedMarkdownHtmlNode(block);

  const textNode = { type: "text", text };
  return block ? { type: "paragraph", content: [textNode] } : textNode;
};

const createDroppedMarkdownHtmlNode = (block?: boolean) => ({
  type: block ? DROPPED_MARKDOWN_HTML_BLOCK : DROPPED_MARKDOWN_HTML_INLINE,
});

const createRawMarkdownHtmlNode = (html: string, block?: boolean) => ({
  type: block ? RAW_MARKDOWN_HTML_BLOCK : RAW_MARKDOWN_HTML_INLINE,
  attrs: { html },
});

const markdownHtmlSelectorMatches = (element: Element, selector: string): boolean => {
  try {
    return element.matches(selector);
  } catch (error) {
    console.warn(`Ignoring invalid markdownHtml selector "${selector}".`, error);
    return false;
  }
};

const markdownHtmlMatches = (element: Element, selectors: string[] | undefined): boolean =>
  normalizeMarkdownHtmlSelectors(selectors).some((selector) => markdownHtmlSelectorMatches(element, selector));

const getMarkdownHtmlAction = (html: string, policy?: MarkdownHtmlPolicy): "keep" | "strip" | "drop" | null => {
  if (!policy) return null;
  const root = getMarkdownHtmlRootElement(html);
  if (!root) return null;
  if (markdownHtmlMatches(root, policy.drop)) return "drop";
  if (markdownHtmlMatches(root, policy.strip)) return "strip";
  if (markdownHtmlMatches(root, policy.keep)) return "keep";
  return null;
};

const createMarkdownHtmlPolicyNode = (html: string, action: "keep" | "strip" | "drop", block?: boolean) => {
  if (action === "drop") return createDroppedMarkdownHtmlNode(block);
  if (action === "strip") return createMarkdownHtmlTextNode(html, block);
  return createRawMarkdownHtmlNode(html, block);
};

const createMarkdownHtmlPolicyNodes = (html: string, policy: MarkdownHtmlPolicy | undefined, block?: boolean) => {
  const topLevelNodes = getMarkdownHtmlTopLevelNodes(html);
  if (topLevelNodes.length <= 1) {
    const action = getMarkdownHtmlAction(html, policy);
    return action ? createMarkdownHtmlPolicyNode(html, action, block) : [];
  }

  const parsedNodes = topLevelNodes.flatMap((node) => {
    if (node instanceof Text) {
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      return text ? [block ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "text", text }] : [];
    }

    if (!(node instanceof Element)) return [];

    const outerHTML = node.outerHTML;
    const action = getMarkdownHtmlAction(outerHTML, policy);
    return action ? [createMarkdownHtmlPolicyNode(outerHTML, action, block)] : [createMarkdownHtmlTextNode(outerHTML, block)];
  });

  return parsedNodes.some((node) => node.type === RAW_MARKDOWN_HTML_BLOCK || node.type === RAW_MARKDOWN_HTML_INLINE || node.type === DROPPED_MARKDOWN_HTML_BLOCK || node.type === DROPPED_MARKDOWN_HTML_INLINE)
    ? parsedNodes
    : [];
};

const tokenizeInlineMarkdownHtml = (src: string, policy?: MarkdownHtmlPolicy) => {
  if (!src.startsWith("<")) return undefined;

  const selfClosingMatch = src.match(/^<[a-z][\w-]*(?:\s[^<>]*)?\/>/i);
  if (selfClosingMatch) {
    const raw = selfClosingMatch[0];
    return getMarkdownHtmlAction(raw, policy) ? { type: RAW_MARKDOWN_HTML_INLINE, raw, text: raw } : undefined;
  }

  const openMatch = src.match(/^<([a-z][\w-]*)(?:\s[^<>]*)?>/i);
  if (!openMatch) return undefined;

  const closingPattern = new RegExp(`<\\/\\s*${openMatch[1]}\\s*>`, "i");
  const closingMatch = closingPattern.exec(src.slice(openMatch[0].length));
  if (!closingMatch) return undefined;

  const end = openMatch[0].length + closingMatch.index + closingMatch[0].length;
  const raw = src.slice(0, end);
  return getMarkdownHtmlAction(raw, policy) ? { type: RAW_MARKDOWN_HTML_INLINE, raw, text: raw } : undefined;
};

const createRawMarkdownHtmlExtensions = (policy?: MarkdownHtmlPolicy) => [
  TiptapNode.create({
    name: DROPPED_MARKDOWN_HTML_INLINE,
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    draggable: false,

    renderHTML() {
      return ["span", { "data-dropped-markdown-html": "", hidden: "true" }];
    },

    renderMarkdown() {
      return "";
    },
  }),
  TiptapNode.create({
    name: DROPPED_MARKDOWN_HTML_BLOCK,
    group: "block",
    atom: true,
    selectable: false,
    draggable: false,

    renderHTML() {
      return ["div", { "data-dropped-markdown-html": "", hidden: "true" }];
    },

    renderMarkdown() {
      return "";
    },
  }),
  TiptapNode.create({
    name: RAW_MARKDOWN_HTML_INLINE,
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    draggable: false,

    addAttributes() {
      return {
        html: {
          default: "",
          parseHTML: (element: HTMLElement) => element.getAttribute("data-raw-markdown-html") ?? "",
          renderHTML: () => ({}),
        },
      };
    },

    parseHTML() {
      return [{ tag: "span[data-raw-markdown-html]" }];
    },

    markdownTokenizer: {
      name: RAW_MARKDOWN_HTML_INLINE,
      level: "inline",
      start: "<",
      tokenize: (src: string) => tokenizeInlineMarkdownHtml(src, policy),
    },

    markdownTokenName: RAW_MARKDOWN_HTML_INLINE,

    parseMarkdown(token) {
      const html = String(token.raw || token.text || "");
      if (!html.trim()) return [];
      return createMarkdownHtmlPolicyNodes(html, policy, false);
    },

    addNodeView() {
      return ({ node }) => ({
        dom: createRawMarkdownHtmlDom(typeof node.attrs?.["html"] === "string" ? node.attrs["html"] : "", "span"),
      });
    },

    renderHTML({ node, HTMLAttributes }) {
      const html = typeof node.attrs?.["html"] === "string" ? node.attrs["html"] : "";
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "data-raw-markdown-html": html,
          contenteditable: "false",
        }),
        html,
      ];
    },

    renderMarkdown(node) {
      return typeof node.attrs?.["html"] === "string" ? node.attrs["html"] : "";
    },
  }),
  TiptapNode.create({
    name: RAW_MARKDOWN_HTML_BLOCK,
    group: "block",
    atom: true,
    selectable: false,
    draggable: false,

    addAttributes() {
      return {
        html: {
          default: "",
          parseHTML: (element: HTMLElement) => element.getAttribute("data-raw-markdown-html") ?? "",
          renderHTML: () => ({}),
        },
      };
    },

    parseHTML() {
      return [{ tag: "div[data-raw-markdown-html]" }];
    },

    addNodeView() {
      return ({ node }) => ({
        dom: createRawMarkdownHtmlDom(typeof node.attrs?.["html"] === "string" ? node.attrs["html"] : "", "div"),
      });
    },

    renderHTML({ node, HTMLAttributes }) {
      const html = typeof node.attrs?.["html"] === "string" ? node.attrs["html"] : "";
      return [
        "div",
        mergeAttributes(HTMLAttributes, {
          "data-raw-markdown-html": html,
          contenteditable: "false",
        }),
        html,
      ];
    },

    markdownTokenName: "html",

    parseMarkdown(token) {
      const html = String(token.raw || token.text || "");
      if (!html.trim()) return [];
      return createMarkdownHtmlPolicyNodes(html, policy, token["block"]);
    },

    renderMarkdown(node) {
      return typeof node.attrs?.["html"] === "string" ? node.attrs["html"] : "";
    },
  }),
];

const UploadableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      uploadId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-upload-id"),
        renderHTML: (attributes: { uploadId?: string | null }) =>
          attributes.uploadId ? { "data-upload-id": attributes.uploadId } : {},
      },
      uploading: {
        default: false,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-uploading") === "true",
        renderHTML: (attributes: { uploading?: boolean }) =>
          attributes.uploading ? { "data-uploading": "true" } : {},
      },
      uploadError: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-upload-error"),
        renderHTML: (attributes: { uploadError?: string | null }) =>
          attributes.uploadError ? { "data-upload-error": attributes.uploadError } : {},
      },
    };
  },
});

export type EditorProps = {
  value?: string;
  revision?: number;
  onChange?: (value: string) => void;
  disabled?: boolean;
  format?: EditorFormat;
  enableImages?: boolean;
  enableImagePasteDrop?: boolean;
  onUploadImage?: ImageUploadHandler;
  imageFallback?: ImageFallbackMode;
  maxImageBytes?: number;
  onRequestImage?: ImagePickerHandler;
  onPendingUploadsChange?: (count: number) => void;
  markdownHtml?: MarkdownHtmlPolicy;
  className?: string;
  editorClassName?: string;
  onAddToChat?: (markdown: string) => void;
} & Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "className">;
export type {
  ImagePickerContext,
  ImagePickerFileResult,
  ImagePickerHandler,
  ImagePickerResult,
  ImagePickerUrlResult,
};

type ToggleAction = {
  label: string;
  icon: IconName;
  isActive: () => boolean;
  run: () => void;
  toggle: true;
};

type PlainAction = {
  label: string;
  icon: IconName;
  run: () => void;
  toggle?: false;
};

type MenuAction = ToggleAction | PlainAction;

type IconButtonOptions = {
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled: boolean;
  toggle?: boolean;
  pressed?: boolean;
  className?: string;
  onMouseDown?: (event: MouseEvent<HTMLButtonElement>) => void;
};

type BlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "blockquote"
  | "codeBlock";

type ActiveState = {
  blockType: BlockType;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
};

const defaultActiveState: ActiveState = {
  blockType: "paragraph",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  link: false,
};

type UploadableImageAttrs = {
  src?: unknown;
  alt?: unknown;
  title?: unknown;
  uploadId?: unknown;
  uploading?: unknown;
  uploadError?: unknown;
  [key: string]: unknown;
};

const toUploadableAttrs = (attrs: unknown): UploadableImageAttrs => {
  if (!attrs || typeof attrs !== "object") return {};
  return attrs as UploadableImageAttrs;
};

const blockOptions: Array<{ value: BlockType; label: string }> = [
  { value: "paragraph", label: "Text" },
  { value: "heading1", label: "Heading 1" },
  { value: "heading2", label: "Heading 2" },
  { value: "heading3", label: "Heading 3" },
  { value: "bulletList", label: "Bulleted list" },
  { value: "orderedList", label: "Numbered list" },
  { value: "blockquote", label: "Quote" },
  { value: "codeBlock", label: "Code block" },
];

export function Editor({
  value = "",
  revision = 0,
  onChange = () => undefined,
  disabled = false,
  format = "html",
  enableImages = true,
  enableImagePasteDrop = false,
  onUploadImage,
  imageFallback = "prompt-url",
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  onRequestImage,
  onPendingUploadsChange,
  markdownHtml,
  className,
  editorClassName,
  onAddToChat,
  ...props
}: EditorProps) {
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [showTableActions, setShowTableActions] = useState(false);
  const [showAltInput, setShowAltInput] = useState(false);
  const [showImageUrlInput, setShowImageUrlInput] = useState(false);
  const showImageUrlInputRef = useRef(false);
  const editorRef = useRef<TiptapEditor | null>(null);
  const [isInTable, setIsInTable] = useState(false);
  const [isOnImage, setIsOnImage] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageAltText, setImageAltText] = useState("");
  const bubbleMenuRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const imageUrlInputRef = useRef<HTMLInputElement>(null);
  const imageUrlWaiterRef = useRef<((result: ImagePickerResult | null) => void) | null>(
    null,
  );
  const pickImageUrlRef = useRef<ImagePickerHandler>(async () => null);
  const lastEmittedValueRef = useRef<string>(value);
  const appliedRevision = useRef(revision);
  const lastSerializedValueRef = useRef<string | null>(null);
  const pendingUploadsRef = useRef(0);
  const objectUrlByUploadIdRef = useRef(new Map<string, string>());
  const expectedBlobByUploadIdRef = useRef(new Map<string, string>());
  const tiptapSurfaceClass = cn(
    "typeset typeset-editor min-h-full w-full bg-transparent px-4 py-3 outline-none placeholder:text-muted-foreground [&_p.is-empty::before]:text-muted-foreground [&_p.is-empty::before]:content-[attr(data-placeholder)] [&_p.is-empty::before]:pointer-events-none [&_p.is-empty::before]:float-left [&_p.is-empty::before]:h-0 [&_td_p.is-empty::before]:content-none [&_th_p.is-empty::before]:content-none [&_img[data-uploading=true]]:opacity-70 [&_img[data-uploading=true]]:animate-pulse [&_img[data-upload-error]]:ring-2 [&_img[data-upload-error]]:ring-destructive [&_img[data-upload-error]]:ring-offset-2 [&_img[data-upload-error]]:ring-offset-background",
    editorClassName,
  );

  const hideBubbleMenu = () => {
    const current = editorRef.current;
    if (!current || current.isDestroyed) return;
    current.view.dispatch(current.state.tr.setMeta(BUBBLE_PLUGIN_KEY, "hide"));
  };

  const beginImageUrlInput = () => {
    imageUrlWaiterRef.current?.(null);
    imageUrlWaiterRef.current = null;
    setShowLinkInput(false);
    setShowTableActions(false);
    setShowAltInput(false);
    showImageUrlInputRef.current = true;
    setShowImageUrlInput(true);
    setImageUrl("");
  };

  const settleImageUrl = (result: ImagePickerResult | null) => {
    const waiter = imageUrlWaiterRef.current;
    imageUrlWaiterRef.current = null;
    const wasAsking = showImageUrlInputRef.current;
    showImageUrlInputRef.current = false;
    if (wasAsking && result == null) hideBubbleMenu();
    setShowImageUrlInput(false);
    setImageUrl("");
    waiter?.(result);
  };

  pickImageUrlRef.current = async () => {
    beginImageUrlInput();
    return new Promise((resolve) => {
      imageUrlWaiterRef.current = resolve;
    });
  };

  const settleImageUrlRef = useRef(settleImageUrl);
  settleImageUrlRef.current = settleImageUrl;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: false,
        underline: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        enableClickSelection: true,
        HTMLAttributes: {
          rel: null,
          target: null,
        },
      }),
      UploadableImage,
      Table,
      TableRow,
      TableHeader,
      TableCell,
      ...createRawMarkdownHtmlExtensions(markdownHtml),
      Placeholder.configure({
        placeholder: ({
          node,
          editor: currentEditor,
        }: {
          node: ProseMirrorNode;
          editor: TiptapEditor;
        }): string =>
          node.type.name === "paragraph" &&
          !currentEditor.isActive("tableCell") &&
          !currentEditor.isActive("tableHeader")
            ? "Press '/' for commands"
            : "",
        showOnlyCurrent: true,
        includeChildren: true,
      }),
      Markdown,
      SlashCommands.configure({
        onRequestImage: enableImages
          ? (onRequestImage ?? ((context) => pickImageUrlRef.current(context)))
          : null,
        onInsertLocalImageFile: ({ file, alt, title }) => {
          void insertLocalImageFile(file, "slash", {
            ...(alt ? { alt } : {}),
            ...(title ? { title } : {}),
          });
        },
        enableImages,
      }),
    ],
    content: value || (format === "markdown" ? "" : "<p></p>"),
    contentType: format,
    editorProps: {
      attributes: {
        class: tiptapSurfaceClass,
      },
      handlePaste: (_view, event) => {
        if (!enableImages || !enableImagePasteDrop) return false;
        const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (!files.length) return false;
        void insertImagesFromFiles(files, "paste");
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved || !enableImages || !enableImagePasteDrop) return false;
        const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (!files.length) return false;

        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (coords?.pos != null) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, coords.pos)));
        }

        void insertImagesFromFiles(files, "drop");
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "/" && showImageUrlInputRef.current) settleImageUrlRef.current(null);
        return false;
      },
    },
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor: nextEditor }) => {
      const nextValue =
        format === "markdown"
          ? nextEditor.getMarkdown()
          : nextEditor
              .getHTML()
              .replace(/\sdata-upload-id="[^"]*"/g, "")
              .replace(/\sdata-uploading="[^"]*"/g, "")
              .replace(/\sdata-upload-error="[^"]*"/g, "");
      if (nextValue === lastSerializedValueRef.current) return;
      lastSerializedValueRef.current = nextValue;
      lastEmittedValueRef.current = nextValue;
      onChange(nextValue);
    },
  });

  editorRef.current = editor ?? null;

  const activeState = (useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      if (!currentEditor) {
        return defaultActiveState;
      }

      const blockType: BlockType = currentEditor.isActive("heading", { level: 1 })
        ? "heading1"
        : currentEditor.isActive("heading", { level: 2 })
          ? "heading2"
          : currentEditor.isActive("heading", { level: 3 })
            ? "heading3"
            : currentEditor.isActive("bulletList")
              ? "bulletList"
              : currentEditor.isActive("orderedList")
                ? "orderedList"
                : currentEditor.isActive("blockquote")
                  ? "blockquote"
                  : currentEditor.isActive("codeBlock")
                    ? "codeBlock"
                    : "paragraph";

      return {
        blockType,
        bold: currentEditor.isActive("bold"),
        italic: currentEditor.isActive("italic"),
        underline: currentEditor.isActive("underline"),
        strike: currentEditor.isActive("strike"),
        code: currentEditor.isActive("code"),
        link: currentEditor.isActive("link"),
      };
    },
  }) as ActiveState | null) ?? defaultActiveState;

  useLayoutEffect(() => {
    if (!editor) return;
    const current =
      format === "markdown" ? editor.getMarkdown() : editor.getHTML();
    if (lastSerializedValueRef.current === null)
      lastSerializedValueRef.current = current;
    const forced = appliedRevision.current !== revision;
    appliedRevision.current = revision;
    if (!forced && value === lastEmittedValueRef.current) return;

    const hasChanged =
      format === "markdown"
        ? value.trimEnd() !== current.trimEnd()
        : value !== current;

    if (hasChanged) {
      const next = createDocument(
        format === "markdown"
          ? editor.markdown!.parse(value)
          : value || "<p></p>",
        editor.schema,
      );
      const before = editor.state.doc;
      const start = before.content.findDiffStart(next.content);
      if (start !== null) {
        const end = before.content.findDiffEnd(next.content)!;
        const overlap = start - Math.min(end.a, end.b);
        if (overlap > 0) {
          end.a += overlap;
          end.b += overlap;
        }
        const scroller = editor.view.dom.closest(".sidetree-md");
        const top = scroller?.scrollTop;
        editor.view.dispatch(
          editor.state.tr
            .replace(start, end.a, next.slice(start, end.b))
            .setMeta("preventUpdate", true)
            .setMeta("addToHistory", false),
        );
        if (scroller && top !== undefined) scroller.scrollTop = top;
      }
      lastSerializedValueRef.current =
        format === "markdown" ? editor.getMarkdown() : editor.getHTML();
      lastEmittedValueRef.current = value;
    }
  }, [editor, value, format, revision]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        attributes: {
          class: tiptapSurfaceClass,
        },
      },
    });
  }, [editor, tiptapSurfaceClass]);

  useEffect(() => {
    if ((!showLinkInput && !showTableActions && !showAltInput && !showImageUrlInput) || !editor) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;

      const insideBubble = bubbleMenuRef.current?.contains(target) ?? false;
      if (!insideBubble) {
        setShowLinkInput(false);
        setShowTableActions(false);
        setShowAltInput(false);
        settleImageUrl(null);
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [showLinkInput, showTableActions, showAltInput, showImageUrlInput, editor]);

  useEffect(() => {
    if (!showLinkInput) return;
    const frameId = requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frameId);
  }, [showLinkInput]);

  useEffect(() => {
    if (!showImageUrlInput || !editor) return;
    editor.commands.focus();
    let innerId = 0;
    const outerId = requestAnimationFrame(() => {
      innerId = requestAnimationFrame(() => {
        imageUrlInputRef.current?.focus();
        imageUrlInputRef.current?.select();
      });
    });
    return () => {
      cancelAnimationFrame(outerId);
      cancelAnimationFrame(innerId);
    };
  }, [showImageUrlInput, editor]);

  useEffect(() => {
    if (!showImageUrlInput) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      settleImageUrl(null);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [showImageUrlInput]);

  useEffect(() => {
    return () => {
      imageUrlWaiterRef.current?.(null);
      imageUrlWaiterRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!editor) return;

    const updateTableContext = () => {
      const nextIsInTable =
        editor.isActive("table") ||
        editor.isActive("tableRow") ||
        editor.isActive("tableHeader") ||
        editor.isActive("tableCell");
      const nextIsOnImage = enableImages && editor.isActive("image");

      setIsInTable(nextIsInTable);
      if (!nextIsInTable) setShowTableActions(false);
      setIsOnImage(nextIsOnImage);
      if (!nextIsOnImage) setShowAltInput(false);
    };

    updateTableContext();
    editor.on("selectionUpdate", updateTableContext);
    editor.on("transaction", updateTableContext);

    return () => {
      editor.off("selectionUpdate", updateTableContext);
      editor.off("transaction", updateTableContext);
    };
  }, [editor, enableImages]);

  useEffect(() => {
    onPendingUploadsChange?.(pendingUploadsRef.current);

    return () => {
      for (const url of objectUrlByUploadIdRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      objectUrlByUploadIdRef.current.clear();
      expectedBlobByUploadIdRef.current.clear();
      pendingUploadsRef.current = 0;
      onPendingUploadsChange?.(0);
    };
  }, [onPendingUploadsChange]);

  if (!editor) return null;

  const updatePendingUploads = (delta: number): void => {
    pendingUploadsRef.current = Math.max(0, pendingUploadsRef.current + delta);
    onPendingUploadsChange?.(pendingUploadsRef.current);
  };

  const createUploadId = (): string =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read image file."));
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsDataURL(file);
    });

  const preloadImageSource = async (src: string, timeoutMs = UPLOADED_IMAGE_PRELOAD_TIMEOUT_MS): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const image = new window.Image();
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        image.onload = null;
        image.onerror = null;
        resolve(false);
      }, timeoutMs);

      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        image.onload = null;
        image.onerror = null;
        resolve(ok);
      };

      image.onerror = () => finish(false);
      image.onload = () => {
        if (typeof image.decode === "function") {
          void image.decode().then(
            () => finish(true),
            // decode errors can still have a usable image after load; keep it non-blocking.
            () => finish(true),
          );
          return;
        }
        finish(true);
      };

      image.src = src;
      if (image.complete && image.naturalWidth > 0) finish(true);
    });

  const findImageNodeByUploadId = (
    uploadId: string,
  ): { pos: number; attrs: UploadableImageAttrs } | null => {
    let match: { pos: number; attrs: UploadableImageAttrs } | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== "image") return true;
      const attrs = toUploadableAttrs(node.attrs);
      if (attrs.uploadId === uploadId) {
        match = { pos, attrs };
        return false;
      }
      return true;
    });
    return match;
  };

  const finalizeImageUpload = (
    uploadId: string,
    updater: (currentAttrs: UploadableImageAttrs) => UploadableImageAttrs | null,
  ): boolean => {
    const match = findImageNodeByUploadId(uploadId);
    if (!match) return false;

    const nextAttrs = updater(match.attrs);
    if (!nextAttrs) return false;

    editor.view.dispatch(editor.state.tr.setNodeMarkup(match.pos, undefined, nextAttrs));
    return true;
  };

  const cleanupUpload = (uploadId: string, options?: { revokeBlob?: boolean }): void => {
    const shouldRevoke = options?.revokeBlob ?? true;
    const objectUrl = objectUrlByUploadIdRef.current.get(uploadId);
    if (shouldRevoke && objectUrl) URL.revokeObjectURL(objectUrl);
    if (shouldRevoke) {
      objectUrlByUploadIdRef.current.delete(uploadId);
    }
    expectedBlobByUploadIdRef.current.delete(uploadId);
    updatePendingUploads(-1);
  };

  const insertLocalImageFile = async (
    file: File,
    source: "paste" | "drop" | "slash",
    initialAttrs?: { alt?: string; title?: string },
  ): Promise<void> => {
    if (!file.type.startsWith("image/")) return;
    const uploadId = createUploadId();
    const blobUrl = URL.createObjectURL(file);
    const fallbackAlt = initialAttrs?.alt ?? file.name;

    objectUrlByUploadIdRef.current.set(uploadId, blobUrl);
    expectedBlobByUploadIdRef.current.set(uploadId, blobUrl);
    updatePendingUploads(1);

    editor
      .chain()
      .focus()
      .insertContent({
        type: "image",
        attrs: {
          src: blobUrl,
          alt: fallbackAlt,
          title: initialAttrs?.title,
          uploadId,
          uploading: true,
          uploadError: null,
        },
      })
      .run();

    try {
      let resolved: ImageUploadResult | null = null;
      if (onUploadImage) {
        resolved = await onUploadImage(file, { editor, source });
      } else if (imageFallback === "data-url") {
        if (file.size <= maxImageBytes) {
          resolved = { src: await fileToDataUrl(file), alt: fallbackAlt };
        }
      }

      if (!resolved?.src) {
        finalizeImageUpload(uploadId, (attrs) => ({
          ...attrs,
          uploading: false,
          uploadError: "Upload failed",
        }));
        cleanupUpload(uploadId, { revokeBlob: false });
        return;
      }

      const preloaded = await preloadImageSource(resolved.src);
      if (!preloaded) {
        finalizeImageUpload(uploadId, (attrs) => ({
          ...attrs,
          uploading: false,
          uploadError: "Image uploaded, but preview failed to load",
        }));
        cleanupUpload(uploadId, { revokeBlob: false });
        return;
      }

      finalizeImageUpload(uploadId, (attrs): UploadableImageAttrs | null => {
        const expectedBlob = expectedBlobByUploadIdRef.current.get(uploadId);
        const currentSrc = typeof attrs.src === "string" ? attrs.src : "";
        if (!expectedBlob || currentSrc !== expectedBlob) return null;

        return {
          ...attrs,
          src: resolved.src,
          alt: resolved.alt ?? (typeof attrs.alt === "string" ? attrs.alt : undefined),
          title: resolved.title ?? (typeof attrs.title === "string" ? attrs.title : undefined),
          uploading: false,
          uploadError: null,
          uploadId: null,
        };
      });

      cleanupUpload(uploadId, { revokeBlob: true });
    } catch (error) {
      finalizeImageUpload(uploadId, (attrs) => ({
        ...attrs,
        uploading: false,
        uploadError: error instanceof Error ? error.message : "Upload failed",
      }));
      cleanupUpload(uploadId, { revokeBlob: false });
    }
  };

  const insertImagesFromFiles = async (files: File[], source: "paste" | "drop"): Promise<void> => {
    for (const file of files) {
      await insertLocalImageFile(file, source);
    }
  };

  const setBlockType = (next: BlockType): void => {
    const chain = editor.chain().focus();

    switch (next) {
      case "paragraph":
        chain.setParagraph().run();
        break;
      case "heading1":
        chain.setHeading({ level: 1 }).run();
        break;
      case "heading2":
        chain.setHeading({ level: 2 }).run();
        break;
      case "heading3":
        chain.setHeading({ level: 3 }).run();
        break;
      case "bulletList":
        chain.toggleBulletList().run();
        break;
      case "orderedList":
        chain.toggleOrderedList().run();
        break;
      case "blockquote":
        chain.toggleBlockquote().run();
        break;
      case "codeBlock":
        chain.toggleCodeBlock().run();
        break;
      default:
        break;
    }
  };

  const inlineActions: MenuAction[] = [
    {
      label: "Bold",
      icon: "Bold",
      isActive: () => activeState.bold,
      run: () => editor.chain().focus().toggleBold().run(),
      toggle: true,
    },
    {
      label: "Italic",
      icon: "Italic",
      isActive: () => activeState.italic,
      run: () => editor.chain().focus().toggleItalic().run(),
      toggle: true,
    },
    {
      label: "Underline",
      icon: "Underline",
      isActive: () => activeState.underline,
      run: () => editor.chain().focus().toggleUnderline().run(),
      toggle: true,
    },
    {
      label: "Strikethrough",
      icon: "Strikethrough",
      isActive: () => activeState.strike,
      run: () => editor.chain().focus().toggleStrike().run(),
      toggle: true,
    },
    {
      label: "Code",
      icon: "Code",
      isActive: () => activeState.code,
      run: () => editor.chain().focus().toggleCode().run(),
      toggle: true,
    },
    {
      label: "Remove formatting",
      icon: "TextClear",
      run: () => editor.chain().focus().unsetAllMarks().clearNodes().run(),
    },
  ];

  const openLinkInput = () => {
    if (showLinkInput) {
      setShowLinkInput(false);
      return;
    }
    const linkAttrs = editor.getAttributes("link");
    const href = typeof linkAttrs["href"] === "string" ? linkAttrs["href"] : "";
    setLinkUrl(editor.isActive("link") ? href : "");
    setShowLinkInput(true);
    setShowTableActions(false);
    setShowAltInput(false);
    settleImageUrl(null);
  };

  const openImageUrlInput = () => {
    if (!enableImages) return;
    if (showImageUrlInput) {
      settleImageUrl(null);
      return;
    }
    beginImageUrlInput();
  };

  const applyImageUrl = () => {
    const src = imageUrl.trim();
    if (!isInsertableImageSrc(src)) return;
    if (imageUrlWaiterRef.current) {
      settleImageUrl({ kind: "url", src });
      return;
    }
    editor.chain().focus().setImage({ src }).run();
    showImageUrlInputRef.current = false;
    setShowImageUrlInput(false);
    setImageUrl("");
  };

  const toggleTableActions = () => {
    if (!isInTable) return;
    setShowTableActions((current) => !current);
    setShowLinkInput(false);
    setShowAltInput(false);
    settleImageUrl(null);
  };

  const toggleAltInput = () => {
    if (!enableImages || !isOnImage) return;
    if (showAltInput) {
      setShowAltInput(false);
      return;
    }
    const imageAttrs = editor.getAttributes("image");
    const alt = imageAttrs["alt"];
    setImageAltText(typeof alt === "string" ? alt : "");
    setShowAltInput(true);
    setShowLinkInput(false);
    setShowTableActions(false);
    settleImageUrl(null);
  };

  const applyLink = () => {
    const trimmed = linkUrl.trim();
    if (!trimmed) return;
    editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
    setShowLinkInput(false);
  };

  const removeLink = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setShowLinkInput(false);
    setLinkUrl("");
  };

  const confirmOrRemoveLink = () => {
    const trimmed = linkUrl.trim();
    if (trimmed || editor.isActive("link")) {
      removeLink();
      return;
    }

    setShowLinkInput(false);
  };

  const applyImageAlt = () => {
    if (!enableImages || !isOnImage) return;
    const trimmed = imageAltText.trim();
    editor
      .chain()
      .focus()
      .updateAttributes("image", {
        alt: trimmed || undefined,
      })
      .run();
    setShowAltInput(false);
  };

  const clearImageAlt = () => {
    if (!enableImages || !isOnImage) return;
    editor.chain().focus().updateAttributes("image", {}).run();
    setImageAltText("");
    setShowAltInput(false);
  };

  const addRow = () => editor.chain().focus().addRowAfter().run();
  const removeRow = () => editor.chain().focus().deleteRow().run();
  const addColumn = () => editor.chain().focus().addColumnAfter().run();
  const removeColumn = () => editor.chain().focus().deleteColumn().run();

  const toolbarButtonClass =
    `inline-flex size-7 cursor-pointer items-center justify-center rounded-sm ${CONTROL_HOVER_TRANSITION} hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50`;
  const toolbarToggleButtonClass = `${toolbarButtonClass} aria-pressed:bg-state-active aria-pressed:text-foreground aria-pressed:hover:bg-state-active`;
  const toolbarInputClass =
    "border-input bg-background text-foreground h-7 rounded-sm border px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

  const renderIconButton = ({
    label,
    icon,
    onClick,
    disabled,
    toggle = false,
    pressed = false,
    className,
    onMouseDown,
  }: IconButtonOptions) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      onMouseDown={onMouseDown}
      disabled={disabled}
      aria-label={label}
      aria-pressed={toggle ? pressed : undefined}
      className={`${toggle ? toolbarToggleButtonClass : toolbarButtonClass}${className ? ` ${className}` : ""}`}
      title={label}
    >
      <Icon name={icon} className="size-4" aria-hidden />
    </button>
  );
  return (
    <div {...props} className={cn("cn-editor", className)}>
      <BubbleMenu
        pluginKey={BUBBLE_PLUGIN_KEY}
        ref={bubbleMenuRef}
        editor={editor}
        updateDelay={0}
        className="z-50 w-fit max-w-[95vw] text-popover-foreground outline-hidden"
        options={{
          placement: "top",
          offset: 10,
          flip: { padding: 8 },
          shift: { padding: 8 },
        }}
        shouldShow={({ editor: bubbleEditor, from, to, view, element }) => {
          const hasEditorFocus = view.hasFocus() || element.contains(document.activeElement);
          if (!hasEditorFocus) return false;
          if (showImageUrlInputRef.current) return true;
          return (
            showLinkInput ||
            showTableActions ||
            showAltInput ||
            (!bubbleEditor.state.selection.empty && from !== to)
          );
        }}
      >
        <div className="flex flex-col gap-1">
          {showImageUrlInput ? (
            <div className="border-border bg-popover flex flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-md border p-1 shadow-sm whitespace-nowrap">
              <input
                id="image-url"
                ref={imageUrlInputRef}
                type="text"
                placeholder="https://example.com/image.png"
                value={imageUrl}
                onChange={(event) => setImageUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    applyImageUrl();
                  }
                }}
                disabled={disabled}
                className={`${toolbarInputClass} min-w-56 flex-1`}
              />
              {renderIconButton({
                label: "Insert image",
                icon: "Check",
                onMouseDown: (event) => event.preventDefault(),
                onClick: applyImageUrl,
                disabled: disabled || !isInsertableImageSrc(imageUrl),
              })}
              {renderIconButton({
                label: "Cancel image",
                icon: "X",
                onMouseDown: (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                },
                onClick: () => settleImageUrl(null),
                disabled,
              })}
            </div>
          ) : null}
          {!showImageUrlInput ? (
          <>
          <div className="border-border bg-popover flex flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-md border p-1 shadow-sm whitespace-nowrap">
            {!isInTable ? (
              <div className="group/native-select relative w-fit">
                <select
                  id="block-style"
                  value={activeState.blockType}
                  onChange={(event) => setBlockType(event.target.value as BlockType)}
                  disabled={disabled}
                  aria-label="Block style"
                  className={`h-7 w-full appearance-none rounded-sm border border-transparent bg-transparent px-2 pr-5.5 text-sm shadow-none outline-none ${CONTROL_HOVER_TRANSITION} hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {blockOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <Icon
                  name="ChevronDown"
                  className="text-muted-foreground pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 opacity-50"
                  aria-hidden
                />
              </div>
            ) : null}
            {inlineActions.map((action) =>
              renderIconButton({
                label: action.label,
                icon: action.icon,
                onClick: action.run,
                disabled,
                toggle: Boolean(action.toggle),
                pressed: action.toggle ? action.isActive() : false,
              }),
            )}
            {renderIconButton({
              label: "Link",
              icon: "Link",
              onClick: openLinkInput,
              disabled,
              toggle: true,
              pressed: showLinkInput || activeState.link,
            })}
            {enableImages
              ? renderIconButton({
                  label: "Image",
                  icon: "Image",
                  onClick: openImageUrlInput,
                  disabled,
                  toggle: true,
                  pressed: showImageUrlInput || isOnImage,
                })
              : null}
            {isOnImage ? (
              <button
                type="button"
                aria-label="Image alt text"
                title="Image alt text"
                aria-pressed={showAltInput}
                onClick={toggleAltInput}
                disabled={disabled}
                className={`${toolbarToggleButtonClass} size-7 text-xs`}
              >
                ALT
              </button>
            ) : null}
            {isInTable
              ? renderIconButton({
                  label: "Table",
                  icon: "Table",
                  onClick: toggleTableActions,
                  disabled,
                  toggle: true,
                  pressed: showTableActions,
                })
              : null}
            {onAddToChat
              ? renderIconButton({
                  label: "Add to chat",
                  icon: "MessageSquarePlus",
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => {
                    const { empty, from, to } = editor.state.selection;
                    if (empty || from === to) return;
                    const json = editor.state.doc.cut(from, to).toJSON();
                    const markdown = editor.markdown?.serialize(json) ?? "";
                    const trimmed = markdown.trimEnd();
                    if (trimmed.trim().length === 0) return;
                    onAddToChat(trimmed);
                  },
                  disabled,
                })
              : null}
          </div>
          {showLinkInput ? (
            <div
              data-state="open"
              className="border-border bg-popover data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-1 flex flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-md border p-1 shadow-sm duration-200 whitespace-nowrap"
            >
              <input
                id="link-url"
                ref={linkInputRef}
                type="url"
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    applyLink();
                  }
                }}
                disabled={disabled}
                className={`${toolbarInputClass} min-w-56 flex-1`}
              />
              {renderIconButton({
                label: "Set link",
                icon: "Check",
                onClick: applyLink,
                disabled: disabled || !linkUrl.trim(),
              })}
              {renderIconButton({
                label: "Remove link",
                icon: "X",
                onClick: confirmOrRemoveLink,
                disabled,
                className: "ml-auto",
              })}
            </div>
          ) : null}
          {showAltInput && isOnImage ? (
            <div
              data-state="open"
              className="border-border bg-popover data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-1 flex flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-md border p-1 shadow-sm duration-200 whitespace-nowrap"
            >
              <input
                id="image-alt"
                type="text"
                placeholder="Describe image"
                value={imageAltText}
                onChange={(event) => setImageAltText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    applyImageAlt();
                  }
                }}
                disabled={disabled}
                className={`${toolbarInputClass} min-w-56 flex-1`}
              />
              {renderIconButton({
                label: "Save alt text",
                icon: "Check",
                onClick: applyImageAlt,
                disabled,
              })}
              {renderIconButton({
                label: "Remove alt text",
                icon: "X",
                onClick: clearImageAlt,
                disabled,
                className: "ml-auto",
              })}
            </div>
          ) : null}
          {showTableActions && isInTable ? (
            <div
              data-state="open"
              className="border-border bg-popover data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-1 inline-flex w-fit flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden self-end rounded-md border p-1 shadow-sm duration-200 whitespace-nowrap"
            >
              <span className="text-sm ml-1 text-muted-foreground">Rows:</span>
              {renderIconButton({
                label: "Add row",
                icon: "Plus",
                onClick: addRow,
                disabled,
              })}
              {renderIconButton({
                label: "Remove row",
                icon: "Minus",
                onClick: removeRow,
                disabled,
              })}
              <span className="bg-border mx-0.5 h-4 w-px" aria-hidden="true" />
              <span className="text-sm text-muted-foreground">Columns:</span>
              {renderIconButton({
                label: "Add column",
                icon: "Plus",
                onClick: addColumn,
                disabled,
              })}
              {renderIconButton({
                label: "Remove column",
                icon: "Minus",
                onClick: removeColumn,
                disabled,
              })}
            </div>
          ) : null}
          </>
          ) : null}
        </div>
      </BubbleMenu>
      <EditorContent editor={editor} />
    </div>
  );
}
