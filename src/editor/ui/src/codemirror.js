// CodeMirror setup: language by file extension, light/dark theme, Mod-S to save.

import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { oneDark } from "@codemirror/theme-one-dark";
import { MergeView } from "@codemirror/merge";

export function languageFor(path) {
  const ext = path.split(".").pop().toLowerCase();
  switch (ext) {
    case "md": case "mdx": case "txt": return markdown();
    case "yml": case "yaml": return yaml();
    case "css": return css();
    case "js": case "mjs": return javascript();
    case "json": return json();
    case "html": case "htm": case "svg": case "xml": return html();
    default: return [];
  }
}

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const themeFor = () => (dark.matches ? oneDark : []);

function baseExtensions({ path, readOnly = false, onSave, onChange }) {
  const theme = new Compartment();
  dark.addEventListener("change", () => views.forEach((v) => v.dispatch({ effects: theme.reconfigure(themeFor()) })));
  return [
    basicSetup,
    keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => (onSave?.(), true) }]),
    languageFor(path),
    EditorView.lineWrapping,
    theme.of(themeFor()),
    EditorState.readOnly.of(readOnly),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange?.(u.state.doc.toString());
    }),
  ];
}

const views = new Set();

/** A CodeMirror editor in `parent`. */
export function createEditor(parent, { path, text, readOnly, onSave, onChange }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: text, extensions: baseExtensions({ path, readOnly, onSave, onChange }) }),
  });
  views.add(view);
  return {
    view,
    text: () => view.state.doc.toString(),
    /** Insert at the cursor (e.g. a link to an uploaded image). */
    insert(snippet) {
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: snippet }, selection: { anchor: from + snippet.length } });
      view.focus();
    },
    destroy() {
      views.delete(view);
      view.destroy();
    },
  };
}

/** Side by side: yours (editable) and theirs, for resolving a conflicting save. */
export function createMerge(parent, { path, mine, theirs }) {
  const ext = [basicSetup, languageFor(path), EditorView.lineWrapping, themeFor()];
  const mv = new MergeView({
    parent,
    a: { doc: mine, extensions: ext },
    b: { doc: theirs, extensions: [...ext, EditorState.readOnly.of(true)] },
    revertControls: "b-to-a",
    highlightChanges: true,
    gutter: true,
  });
  return { text: () => mv.a.state.doc.toString(), destroy: () => mv.destroy() };
}
