// The editor UI (docs/EDITOR.md): file tree, CodeMirror or the visual
// Markdown editor, live preview.

import { h, render } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import htm from "htm";
import { api, ApiError } from "./api.js";
import { createEditor, createMerge } from "./codemirror.js";
import { Icon } from "./icons.js";
import { isMarkdown, resolveSourcePath } from "./markdown.js";

const html = htm.bind(h);
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseName = (p) => p.split("/").pop();
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|ico)$/i;

function App() {
  const [me, setMe] = useState(null);
  const [dirs, setDirs] = useState({}); // dir → entries
  const [expanded, setExpanded] = useState(new Set([""]));
  const [file, setFile] = useState(null); // { path, hash, text, binary, url, writable }
  const [selected, setSelected] = useState(null); // { path, type }
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(() => localStorage.getItem("ursa-edit-preview") !== "off");
  const [visual, setVisual] = useState(() => localStorage.getItem("ursa-edit-mode") !== "markdown");
  const [previewKey, setPreviewKey] = useState(0);
  const [toast, setToast] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const editorRef = useRef(null);

  const notify = useCallback((message, kind = "info") => {
    setToast({ message, kind, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "error" ? 8000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const loadDir = useCallback(async (dir) => {
    const { entries } = await api.tree(dir);
    setDirs((d) => ({ ...d, [dir]: entries }));
    return entries;
  }, []);

  const reveal = useCallback(async (path) => {
    // Expand every folder above a path, loading as needed
    const parts = dirOf(path).split("/").filter(Boolean);
    const open = new Set(expanded);
    let dir = "";
    open.add("");
    for (const p of parts) {
      dir = join(dir, p);
      open.add(dir);
      if (!dirs[dir]) await loadDir(dir).catch(() => {});
    }
    setExpanded(open);
  }, [expanded, dirs, loadDir]);

  const openFile = useCallback(async (path, { replace = false } = {}) => {
    if (dirty && !confirm(`Discard unsaved changes to ${file.path}?`)) return;
    try {
      const f = await api.file(path);
      setFile({ ...f, loadId: Date.now() });
      setDirty(false);
      setSelected({ path, type: "file" });
      const url = `?path=${encodeURIComponent(path)}`;
      if (replace) history.replaceState(null, "", url);
      else history.pushState(null, "", url);
      document.title = `${baseName(path)} · Edit`;
      reveal(path);
    } catch (e) {
      notify(e.message, "error");
    }
  }, [dirty, file, reveal, notify]);

  // Start: who am I, the root folder, and which file to open (?path= or ?page=)
  useEffect(() => {
    (async () => {
      try {
        setMe(await api.me());
        await loadDir("");
        const q = new URLSearchParams(location.search);
        if (q.get("path")) return openFile(q.get("path"), { replace: true });
        if (q.get("page")) {
          const r = await api.resolve(q.get("page"));
          if (r.path) return openFile(r.path, { replace: true });
          if (r.dir != null) {
            notify(`That page is generated for the folder "${r.dir || "/"}". Create an index.md there to give it content.`);
            setSelected({ path: r.dir, type: "dir" });
            reveal(join(r.dir, "x"));
          }
        }
      } catch (e) {
        notify(e.message, "error");
      }
    })();
    const onPop = () => {
      const p = new URLSearchParams(location.search).get("path");
      if (p) openFile(p, { replace: true });
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const warn = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!file || file.binary || !editorRef.current || saving) return;
    const text = editorRef.current.text();
    setSaving(true);
    try {
      const r = await api.save(file.path, text, file.hash);
      setFile((f) => ({ ...f, hash: r.hash, text, draft: null, url: r.url ?? f.url }));
      setDirty(false);
      notify("Saved. The page rebuilds in a moment.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) {
        const theirs = await api.file(file.path).catch(() => null);
        setConflict({ mine: text, theirs });
      } else {
        notify(`Not saved: ${e.message}`, "error");
      }
    } finally {
      setSaving(false);
    }
  }, [file, saving, notify]);

  // Folder the toolbar actions apply to: the selected folder, or the open file's
  const currentDir = selected?.type === "dir" ? selected.path : file ? dirOf(file.path) : "";

  const refresh = (...ds) => Promise.all([...new Set(ds)].map((d) => loadDir(d).catch(() => {})));

  const actions = {
    async newFile() {
      const name = await ask({ title: "New page", label: `In /${currentDir}`, value: "untitled.md" });
      if (!name) return;
      const path = join(currentDir, name.replace(/^\/+/, ""));
      const title = baseName(path).replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
      try {
        await api.create(path, /\.(md|mdx)$/.test(path) ? `# ${title}\n\n` : "");
        await refresh(dirOf(path));
        openFile(path);
      } catch (e) {
        notify(e.message, "error");
      }
    },
    async newFolder() {
      const name = await ask({ title: "New folder", label: `In /${currentDir}`, value: "" });
      if (!name) return;
      try {
        await api.mkdir(join(currentDir, name));
        await refresh(currentDir);
        setExpanded((s) => new Set([...s, currentDir]));
      } catch (e) {
        notify(e.message, "error");
      }
    },
    async upload(files, dir = currentDir) {
      const done = [];
      for (const f of files) {
        const name = f.name.replace(/\s+/g, "-");
        try {
          await api.create(join(dir, name), f, f.type || "application/octet-stream");
          done.push(name);
        } catch (e) {
          notify(`${name}: ${e.status === 412 ? "a file with that name exists" : e.message}`, "error");
        }
      }
      if (done.length) {
        await refresh(dir);
        notify(`Uploaded ${done.join(", ")}`);
      }
      return done;
    },
    async rename() {
      if (!selected?.path) return;
      const to = await ask({ title: "Rename or move", label: "New path", value: selected.path });
      if (!to || to === selected.path) return;
      if (dirty && file?.path === selected.path) return notify("Save first, then rename.", "error");
      try {
        await api.move(selected.path, to);
        await refresh(dirOf(selected.path), dirOf(to));
        if (file?.path === selected.path) openFile(to, { replace: true });
        else setSelected({ ...selected, path: to });
      } catch (e) {
        notify(e.message, "error");
      }
    },
    async remove() {
      if (!selected?.path) return;
      const ok = await ask({ title: "Delete", message: `Delete ${selected.path}${selected.type === "dir" ? " (must be empty)" : ""}? This can't be undone here.`, confirm: "Delete" });
      if (!ok) return;
      try {
        let hash = null;
        if (selected.type === "file") hash = file?.path === selected.path ? file.hash : (await api.file(selected.path)).hash;
        await api.remove(selected.path, hash);
        await refresh(dirOf(selected.path));
        if (file?.path === selected.path) {
          setFile(null);
          setDirty(false);
          history.replaceState(null, "", "?");
        }
        setSelected(null);
      } catch (e) {
        notify(e.message, "error");
      }
    },
  };

  function ask(opts) {
    return new Promise((resolve) => setDialog({ ...opts, resolve }));
  }

  const togglePreview = () => {
    localStorage.setItem("ursa-edit-preview", preview ? "off" : "on");
    setPreview(!preview);
  };

  // Markdown pages open in the visual editor unless you'd rather see the source
  const canVisual = file && !file.binary && file.writable && isMarkdown(file.path);
  const switchMode = (toVisual) => {
    localStorage.setItem("ursa-edit-mode", toVisual ? "visual" : "markdown");
    setVisual(toVisual);
    // Unsaved text carries over into the other editor
    const draft = editorRef.current?.text() ?? null;
    setFile((f) => (f ? { ...f, draft, loadId: Date.now() } : f));
  };
  const editorProps = {
    file,
    editorRef,
    onChange: (text) => setDirty(text !== file.text),
    onSave: save,
  };

  return html`
    <div class="app" data-tree=${treeOpen ? "open" : "closed"}>
      <header class="bar">
        <button data-button class="tool" title="Files" onClick=${() => setTreeOpen(!treeOpen)}><${Icon} name="sidebar" /></button>
        <a class="site" href="/" title="Back to the site">${me?.site ?? "…"}</a>
        <span class="path" title=${file?.path ?? ""}>${file ? file.path : "Choose a file"}${dirty ? html` <span class="dot" title="Unsaved changes">●</span>` : ""}</span>
        <span class="spacer"></span>
        ${file?.url && html`<a data-button class="tool" href=${file.url} target="_blank" title="Open page"><${Icon} name="external" /></a>`}
        ${canVisual && html`<button data-button class="tool" title=${visual ? "Edit the Markdown source" : "Edit visually"} onClick=${() => switchMode(!visual)} aria-pressed=${!visual}><${Icon} name="markdown" /></button>`}
        ${file && !file.binary && html`<button data-button class="tool" title=${preview ? "Hide preview" : "Show preview"} onClick=${togglePreview} aria-pressed=${preview}><${Icon} name="eye" /></button>`}
        ${file && !file.binary && file.writable && html`
          <button data-button="raised primary" class="save" disabled=${!dirty || saving} onClick=${save} title="Save (Ctrl+S)">
            <${Icon} name="save" /> ${saving ? "Saving…" : "Save"}
          </button>`}
        <${Account} me=${me} />
      </header>

      <nav class="tree" aria-label="Files">
        <div class="tree-actions">
          <button data-button class="tool" title=${`New page in /${currentDir}`} onClick=${actions.newFile}><${Icon} name="file-plus" /></button>
          <button data-button class="tool" title=${`New folder in /${currentDir}`} onClick=${actions.newFolder}><${Icon} name="folder-plus" /></button>
          <label data-button class="tool" title=${`Upload to /${currentDir}`}>
            <${Icon} name="upload" />
            <input type="file" multiple hidden onChange=${(e) => { actions.upload([...e.target.files]); e.target.value = ""; }} />
          </label>
          <span class="spacer"></span>
          <button data-button class="tool" title="Rename or move" disabled=${!selected?.path} onClick=${actions.rename}><${Icon} name="pencil" /></button>
          <button data-button class="tool" title="Delete" disabled=${!selected?.path} onClick=${actions.remove}><${Icon} name="trash" /></button>
        </div>
        <${Tree}
          dir="" depth=${0} dirs=${dirs} expanded=${expanded} openPath=${file?.path} selected=${selected?.path}
          onToggle=${async (d) => {
            const s = new Set(expanded);
            if (s.has(d)) s.delete(d);
            else {
              s.add(d);
              if (!dirs[d]) await loadDir(d).catch((e) => notify(e.message, "error"));
            }
            setExpanded(s);
            setSelected({ path: d, type: "dir" });
          }}
          onOpen=${(p) => openFile(p)}
        />
      </nav>

      <main class="work" data-preview=${preview && file && !file.binary ? "on" : "off"}>
        ${!file && html`<div class="empty"><p>Pick a file on the left, or start a new page.</p></div>`}
        ${file && file.binary && html`<${BinaryView} file=${file} />`}
        ${canVisual && visual && html`
          <${VisualEditor}
            key=${file.path + "#" + file.loadId}
            ...${editorProps}
            onUpload=${async (f) => {
              const [name] = await actions.upload([f], dirOf(file.path));
              if (!name) throw new Error(`${f.name} wasn't uploaded`);
              return name;
            }}
            onFallback=${(message) => {
              if (message) notify(message, "error");
              switchMode(false);
            }}
          />`}
        ${file && !file.binary && !(canVisual && visual) && html`
          <${Editor}
            key=${file.path + "#" + file.loadId}
            ...${editorProps}
            onDropFiles=${async (files) => {
              const dir = dirOf(file.path);
              const names = await actions.upload(files, dir);
              for (const n of names) editorRef.current?.insert(IMAGE.test(n) ? `![${n.replace(/\.[^.]+$/, "")}](${n})\n` : `[${n}](${n})\n`);
            }}
          />`}
        ${file && !file.binary && preview && html`<${Preview} file=${file} reloadKey=${previewKey} />`}
      </main>

      ${toast && html`<div data-snackbar class=${"toast " + toast.kind} role="status" key=${toast.id}>${toast.message}</div>`}
      ${dialog && html`<${Dialog} ...${dialog} close=${(v) => { dialog.resolve(v); setDialog(null); }} />`}
      ${conflict && html`
        <${Conflict}
          file=${file}
          mine=${conflict.mine}
          theirs=${conflict.theirs}
          onCancel=${() => setConflict(null)}
          onUseTheirs=${() => {
            setConflict(null);
            setDirty(false);
            setFile({ ...conflict.theirs, loadId: Date.now() });
          }}
          onSaveMerged=${async (text) => {
            try {
              const r = conflict.theirs ? await api.save(file.path, text, conflict.theirs.hash) : await api.create(file.path, text);
              setConflict(null);
              setDirty(false);
              setFile({ ...file, text, draft: null, hash: r.hash, loadId: Date.now() });
              setPreviewKey((k) => k + 1);
              notify("Merged and saved.");
            } catch (e) {
              notify(`Not saved: ${e.message}`, "error");
            }
          }}
        />`}
    </div>`;
}

function Account({ me }) {
  if (!me?.user) return null;
  const u = me.user;
  if (u.name === "Local editor" && !u.email) return null;
  return html`<span class="account">
    <a href="/auth/profile" title=${u.email ?? ""}>${u.name ?? u.email}</a>
    <a href="/auth/logout" data-button class="tool" title="Sign out"><${Icon} name="logout" /></a>
  </span>`;
}

function Tree({ dir, depth, dirs, expanded, openPath, selected, onToggle, onOpen }) {
  const entries = dirs[dir];
  if (!entries) return html`<div class="tree-loading" style=${{ paddingInlineStart: `${8 + (depth + 1) * 16}px` }}>…</div>`;
  return html`<ul class="tree-list" role=${depth === 0 ? "tree" : "group"}>
    ${entries.map((e) => {
      const open = expanded.has(e.path);
      const isSel = selected === e.path;
      return html`<li key=${e.path} role="treeitem" aria-expanded=${e.type === "dir" ? open : undefined} aria-selected=${isSel}>
        <button
          class=${"tree-item" + (openPath === e.path ? " open" : "") + (isSel ? " selected" : "") + (e.writable ? "" : " readonly")}
          style=${{ paddingInlineStart: `${8 + depth * 16}px` }}
          onClick=${() => (e.type === "dir" ? onToggle(e.path) : onOpen(e.path))}
          title=${e.writable ? e.path : `${e.path} (read-only for you)`}
        >
          <${Icon} name=${e.type === "dir" ? (open ? "folder-open" : "folder") : IMAGE.test(e.name) ? "photo" : "file"} />
          <span>${e.name}</span>
        </button>
        ${e.type === "dir" && open && html`<${Tree} dir=${e.path} depth=${depth + 1} dirs=${dirs} expanded=${expanded} openPath=${openPath} selected=${selected} onToggle=${onToggle} onOpen=${onOpen} />`}
      </li>`;
    })}
  </ul>`;
}

function Editor({ file, editorRef, onChange, onSave, onDropFiles }) {
  const host = useRef(null);
  const saveRef = useRef(onSave);
  const changeRef = useRef(onChange);
  saveRef.current = onSave;
  changeRef.current = onChange;
  useEffect(() => {
    const ed = createEditor(host.current, {
      path: file.path,
      text: file.draft ?? file.text,
      readOnly: !file.writable,
      onSave: () => saveRef.current(),
      onChange: (t) => changeRef.current(t),
    });
    editorRef.current = ed;
    ed.view.focus();
    return () => {
      ed.destroy();
      if (editorRef.current === ed) editorRef.current = null;
    };
  }, []); // one editor per loaded file (keyed by the parent); saving keeps it
  const [over, setOver] = useState(false);
  return html`<section
    class=${"editor" + (over ? " drop" : "")}
    ref=${host}
    onDragOver=${(e) => {
      if (!file.writable || !e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      setOver(true);
    }}
    onDragLeave=${() => setOver(false)}
    onDrop=${(e) => {
      if (!file.writable || !e.dataTransfer?.files?.length) return;
      e.preventDefault();
      setOver(false);
      onDropFiles([...e.dataTransfer.files]);
    }}
  >${!file.writable && html`<div class="readonly-note">Read-only: you can't change this file.</div>`}</section>`;
}

/**
 * Gravity UI's markdown editor (wysiwyg.js), in an iframe of its own: it is
 * React with its own stylesheet, and pure-material styles every bare button.
 */
function VisualEditor({ file, editorRef, onChange, onSave, onUpload, onFallback }) {
  const frame = useRef(null);
  const [rewrites, setRewrites] = useState(false);
  const latest = useRef({});
  latest.current = { onChange, onSave, onUpload, onFallback };
  useEffect(() => {
    let ed = null;
    const start = () => {
      const win = frame.current?.contentWindow;
      if (!win?.createWysiwyg) return latest.current.onFallback("The visual editor didn't load; showing the Markdown instead.");
      try {
        ed = win.createWysiwyg(win.document.getElementById("root"), {
          text: file.draft ?? file.text,
          onSave: () => latest.current.onSave(),
          onChange: (t) => latest.current.onChange(t),
          // Files from the frame belong to its window: copy them into this one for fetch()
          upload: async (f) => latest.current.onUpload(new File([await f.arrayBuffer()], f.name, { type: f.type })),
          imageUrl: (src) => {
            const p = resolveSourcePath(dirOf(file.path), src);
            return p ? api.rawUrl(p) : src;
          },
        });
      } catch (e) {
        return latest.current.onFallback(`The visual editor failed (${e.message}); showing the Markdown instead.`);
      }
      editorRef.current = ed;
      setRewrites(ed.rewrites);
    };
    const el = frame.current;
    if (el.contentWindow?.createWysiwyg) start();
    else el.addEventListener("load", start, { once: true });
    return () => {
      el.removeEventListener("load", start);
      ed?.destroy();
      if (editorRef.current === ed) editorRef.current = null;
    };
  }, []); // one editor per loaded file (keyed by the parent)
  return html`<section class="editor visual">
    ${rewrites && html`<div class="rewrite-note" role="status">
      <span>Saving from the visual editor will rewrite parts of this page's Markdown it doesn't understand${/^---/.test(file.text) ? " (front matter is kept as is)" : ""}.</span>
      <button data-button onClick=${() => onFallback()}>Edit as Markdown</button>
      <button data-button class="tool" title="Dismiss" onClick=${() => setRewrites(false)}>×</button>
    </div>`}
    <iframe ref=${frame} src="wysiwyg/" title="Visual editor"></iframe>
  </section>`;
}

function Preview({ file, reloadKey }) {
  if (!file.url) {
    return html`<aside class="preview empty"><p>No page is built from this file${/\.(md|mdx|txt|ya?ml)$/.test(file.path) ? " yet" : ""}.</p></aside>`;
  }
  // The page reloads itself when it's rebuilt (Ursa's live reload)
  return html`<aside class="preview"><iframe key=${file.url + reloadKey} src=${file.url} title="Preview"></iframe></aside>`;
}

function BinaryView({ file }) {
  return html`<div class="binary">
    ${IMAGE.test(file.path) ? html`<img src=${api.rawUrl(file.path) + "&h=" + file.hash} alt=${file.path} />` : html`<p>${file.path} isn't a text file.</p>`}
    <p class="meta">${(file.size / 1024).toFixed(1)} KB · <a href=${api.rawUrl(file.path)} download=${baseName(file.path)}>Download</a>${file.url ? html` · <a href=${file.url} target="_blank">Open</a>` : ""}</p>
  </div>`;
}

function Dialog({ title, label, message, value, confirm: confirmText, close }) {
  const ref = useRef(null);
  const [v, setV] = useState(value ?? "");
  useEffect(() => {
    ref.current.showModal();
    const input = ref.current.querySelector("input");
    if (input) {
      input.focus();
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(input.value.lastIndexOf("/") + 1, dot > 0 ? dot : input.value.length);
    }
  }, []);
  const isPrompt = value !== undefined;
  return html`<dialog ref=${ref} class="dialog" onCancel=${() => close(null)}>
    <form method="dialog" onSubmit=${(e) => { e.preventDefault(); close(isPrompt ? v.trim() : true); }}>
      <h2>${title}</h2>
      ${message && html`<p>${message}</p>`}
      ${isPrompt && html`<label>${label}<input value=${v} onInput=${(e) => setV(e.target.value)} /></label>`}
      <footer>
        <button type="button" data-button onClick=${() => close(null)}>Cancel</button>
        <button type="submit" data-button="raised primary">${confirmText ?? "OK"}</button>
      </footer>
    </form>
  </dialog>`;
}

function Conflict({ file, mine, theirs, onCancel, onUseTheirs, onSaveMerged }) {
  const ref = useRef(null);
  const host = useRef(null);
  const merge = useRef(null);
  useEffect(() => {
    ref.current.showModal();
    if (theirs && !theirs.binary) merge.current = createMerge(host.current, { path: file.path, mine, theirs: theirs.text });
    return () => merge.current?.destroy();
  }, []);
  return html`<dialog ref=${ref} class="dialog conflict" onCancel=${onCancel}>
    <h2>Someone else changed ${baseName(file.path)}</h2>
    ${theirs
      ? html`<p>Left: your version (edit it to combine both). Right: what's saved now. Arrows copy their changes into yours.</p>
             <div class="merge" ref=${host}></div>`
      : html`<p>The file was deleted or renamed while you edited it. Saving will recreate it.</p>`}
    <footer>
      <button data-button onClick=${onCancel}>Keep editing</button>
      ${theirs && html`<button data-button onClick=${onUseTheirs}>Discard mine, use theirs</button>`}
      <button data-button="raised primary" onClick=${() => (theirs ? onSaveMerged(merge.current.text()) : onSaveMerged(mine))}>Save mine</button>
    </footer>
  </dialog>`;
}

render(html`<${App} />`, document.getElementById("app"));
