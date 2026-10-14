// The visual (WYSIWYG) Markdown editor: Gravity UI's markdown-editor, in React.
// Built separately into dist/wysiwyg/ and run in an iframe (wysiwyg.html), so
// the plain editor stays small and neither side's CSS reaches the other. The
// editor page calls window.createWysiwyg; it returns the same handle as
// createEditor() in codemirror.js.

import { createElement as h, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ThemeProvider, Toaster, ToasterComponent, ToasterProvider, configure as configureUikit } from "@gravity-ui/uikit";
import { MarkdownEditorView, useMarkdownEditor, configure, Deflist, Superscript } from "@gravity-ui/markdown-editor";
import { Plugin } from "@gravity-ui/markdown-editor/pm/state.js";
import "@gravity-ui/uikit/styles/styles.css";
import { splitFrontMatter } from "./markdown.js";

configureUikit({ lang: "en" });
configure({ lang: "en" });
const toaster = new Toaster();

/**
 * @param {HTMLElement} parent
 * @param {object} opts
 * @param {string} opts.text - the whole file, front matter included
 * @param {() => void} opts.onSave
 * @param {(text: string) => void} opts.onChange - the file's text after a change
 * @param {(file: File) => Promise<string>} opts.upload - store a dropped/pasted file, return its link
 * @param {(src: string) => string} opts.imageUrl - where the editor can load an image the page links to
 * @returns {{ text: () => string, insert: (md: string) => void, rewrites: boolean, destroy: () => void }}
 */
export function createWysiwyg(parent, { text, onSave, onChange, upload, imageUrl }) {
  const [frontMatter, body] = splitFrontMatter(text);
  const newline = text.endsWith("\n") ? "\n" : "";
  let editor = null;
  let baseline = null;

  // Images load from the source (relative links would otherwise resolve against /edit/)
  const images = (builder) =>
    builder.addPlugin(() => new Plugin({
      props: {
        nodeViews: {
          image: (node) => {
            const img = document.createElement("img");
            for (const [k, v] of Object.entries(node.attrs)) if (v != null && k !== "src") img.setAttribute(k, v);
            img.src = imageUrl(node.attrs.src);
            return { dom: img };
          },
        },
      },
    }), builder.Priority.Highest);

  // Ursa renders definition lists and ^superscript^ too
  const extensions = (builder) => builder.use(Deflist, {}).use(Superscript).use(images);

  const serialize = () => frontMatter + editor.getValue().replace(/\s*$/, newline);
  // Unchanged → the file exactly as it was, even where the editor would write it differently
  const current = () => {
    const s = serialize();
    return s === baseline ? text : s;
  };

  function Wysiwyg() {
    editor = useMarkdownEditor({
      preset: "default",
      md: { html: true, linkify: false, breaks: false },
      initial: { markup: body, mode: "wysiwyg", toolbarVisible: true },
      handlers: { uploadFile: async (file) => ({ url: await upload(file) }) },
      wysiwygConfig: { extensions },
      markupConfig: { splitMode: false },
    });
    useEffect(() => {
      const changed = () => onChange(current());
      editor.on("change", changed);
      return () => editor.off("change", changed);
    }, [editor]);
    return h(ThemeProvider, { theme: "system" },
      h(ToasterProvider, { toaster },
        h(MarkdownEditorView, { editor, stickyToolbar: true, autofocus: true, settingsVisible: false }),
        h(ToasterComponent)));
  }

  // Mod-S saves, as in the plain editor
  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      onSave();
    }
  };
  parent.addEventListener("keydown", onKey, true);

  let failed = null;
  const root = createRoot(parent, { onUncaughtError: (e) => (failed = e) });
  flushSync(() => root.render(h(Wysiwyg)));
  if (failed) {
    parent.removeEventListener("keydown", onKey, true);
    root.unmount();
    throw failed;
  }
  baseline = serialize();

  return {
    text: current,
    /** Insert Markdown at the cursor (links to uploaded files). */
    insert(md) {
      editor.insert(md);
      editor.focus();
    },
    /** Whether saving would reformat parts of the page the editor doesn't understand. */
    rewrites: normalize(baseline) !== normalize(text),
    destroy() {
      parent.removeEventListener("keydown", onKey, true);
      root.unmount();
    },
  };
}

window.createWysiwyg = createWysiwyg;

/** Differences that don't change the page: line endings, blank lines, table padding, default alignment. */
function normalize(s) {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!/^\s*\|/.test(line)) return line.replace(/[ \t]+$/, "");
      const row = line.trim().replace(/\s*\|\s*/g, "|");
      // |:---|  and  | --- |  both mean "default alignment"
      return /^[|:\- ]+$/.test(row) ? row.replace(/(?<=\|):?-+(?=\|)/g, "---") : row;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
