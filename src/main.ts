import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";

type Mode = "convert" | "trim" | "filters" | "gif";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const state = {
  mode: "convert" as Mode,
  file: null as string | null,
  duration: 0,
  meta: "",
  trimIn: 0,
  trimOut: 0,
  converting: false,
};

// ---------- helpers ----------

function fmtTime(s: number): string {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

function parseTime(t: string): number {
  const parts = t.trim().split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function stripExt(p: string): string {
  const i = p.lastIndexOf(".");
  return i > 0 ? p.slice(0, i) : p;
}

// ---------- command building ----------

function buildFilters(): string[] {
  const f: string[] = [];
  if ((<HTMLInputElement>$("f-crop")).checked) {
    const w = (<HTMLInputElement>$("crop-w")).value || "1280";
    const h = (<HTMLInputElement>$("crop-h")).value || "720";
    f.push(`crop=${w}:${h}`);
  }
  if ((<HTMLInputElement>$("f-scale")).checked) {
    const w = (<HTMLInputElement>$("scale-w")).value || "1920";
    const h = (<HTMLInputElement>$("scale-h")).value || "-2";
    f.push(`scale=${w}:${h}`);
  }
  if ((<HTMLInputElement>$("f-denoise")).checked) f.push("hqdn3d");
  if ((<HTMLInputElement>$("f-watermark")).checked) {
    const text = (<HTMLInputElement>$("wm-text")).value.replace(/['\\:]/g, "");
    const op = Number((<HTMLInputElement>$("wm-opacity")).value) / 100;
    const pos = (<HTMLSelectElement>$("wm-pos")).value;
    const xy = {
      br: "x=w-tw-20:y=h-th-20",
      bl: "x=20:y=h-th-20",
      tr: "x=w-tw-20:y=20",
      tl: "x=20:y=20",
    }[pos]!;
    f.push(
      `drawtext=text='${text}':${xy}:fontsize=18:fontcolor=white@${op.toFixed(2)}`
    );
  }
  return f;
}

function trimArgs(): string[] {
  const enabled =
    state.mode === "trim" ||
    state.mode === "gif" ||
    (<HTMLInputElement>$("trim-enabled")).checked;
  if (!enabled || state.duration === 0) return [];
  if (state.trimIn <= 0 && state.trimOut >= state.duration) return [];
  return ["-ss", fmtTime(state.trimIn), "-to", fmtTime(state.trimOut)];
}

// Builds args after "-i input"; returns [args, outExt]
function buildArgs(): { pre: string[]; post: string[]; ext: string } {
  const pre = trimArgs();
  const post: string[] = [];

  if (state.mode === "gif") {
    const fps = (<HTMLSelectElement>$("gif-fps")).value;
    const width = (<HTMLInputElement>$("gif-width")).value || "480";
    const palette = (<HTMLInputElement>$("gif-palette")).checked;
    const base = `fps=${fps},scale=${width}:-1:flags=lanczos`;
    const vf = palette
      ? `${base},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`
      : base;
    post.push("-vf", vf, "-loop", "0");
    return { pre, post, ext: "gif" };
  }

  const fmt = (<HTMLSelectElement>$("out-format")).value;
  const filters = buildFilters();

  if (fmt === "mp3" || fmt === "wav") {
    post.push("-vn");
    if (fmt === "mp3") post.push("-c:a", "libmp3lame", "-b:a", (<HTMLSelectElement>$("abitrate")).value);
    return { pre, post, ext: fmt };
  }

  const vcodec = (<HTMLSelectElement>$("vcodec")).value;
  const trimCopy =
    state.mode === "trim" && (<HTMLInputElement>$("trim-copy")).checked;

  if (trimCopy) {
    post.push("-c", "copy");
    return { pre, post, ext: fmt };
  }

  if (filters.length && vcodec !== "copy") post.push("-vf", filters.join(","));
  post.push("-c:v", vcodec);
  if (vcodec !== "copy") {
    post.push("-crf", (<HTMLInputElement>$("crf")).value);
    post.push("-preset", (<HTMLSelectElement>$("preset")).value);
  }
  const acodec = (<HTMLSelectElement>$("acodec")).value;
  if (acodec === "none") post.push("-an");
  else {
    post.push("-c:a", acodec);
    if (acodec !== "copy") post.push("-b:a", (<HTMLSelectElement>$("abitrate")).value);
  }
  return { pre, post, ext: fmt };
}

function updateCmd() {
  const { pre, post, ext } = buildArgs();
  const input = state.file ? baseName(state.file) : "input.mp4";
  const out = `${stripExt(input)}_out.${ext}`;
  const parts = ["ffmpeg", ...pre, "-i", input, ...post, out].map((p) =>
    /[\s'";\[\]]/.test(p) ? `"${p}"` : p
  );
  $("cmd").textContent = parts.join(" ");
}

// ---------- file loading ----------

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}
interface ProbeInfo {
  format?: { duration?: string };
  streams?: ProbeStream[];
}

async function loadFile(path: string) {
  try {
    const info = await invoke<ProbeInfo>("probe_media", { path });
    const dur = Number(info.format?.duration ?? 0);
    const streams = info.streams ?? [];
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    const bits: string[] = [];
    if (v) bits.push(`${v.width}x${v.height}`, v.codec_name ?? "");
    if (a) bits.push(a.codec_name ?? "");
    bits.push(fmtTime(dur));

    state.file = path;
    state.duration = dur;
    state.trimIn = 0;
    state.trimOut = dur;
    state.meta = bits.join(" · ");

    const video = $<HTMLVideoElement>("video");
    video.src = convertFileSrc(path);
    video.controls = true;
    video.hidden = false;
    $("preview-empty").hidden = true;
    $("preview-duration").hidden = false;
    $("preview-duration").textContent = fmtTime(dur);
    $("timeline-wrap").hidden = false;
    $("side-file").hidden = false;
    $("file-name").textContent = baseName(path);
    $("file-meta").textContent = state.meta;
    (<HTMLButtonElement>$("btn-convert")).disabled = false;
    setStatus("");
    renderTimeline();
    updateCmd();
  } catch (e) {
    setStatus(String(e), "error");
  }
}

async function pickFile() {
  const path = await open({
    multiple: false,
    filters: [
      {
        name: "Media",
        extensions: [
          "mp4", "mkv", "mov", "webm", "avi", "m4v", "ts",
          "mp3", "wav", "flac", "aac", "ogg", "m4a",
        ],
      },
    ],
  });
  if (typeof path === "string") await loadFile(path);
}

// ---------- timeline ----------

function renderTimeline() {
  if (state.duration === 0) return;
  const inPct = (state.trimIn / state.duration) * 100;
  const outPct = (state.trimOut / state.duration) * 100;
  const range = $("tl-range");
  range.style.left = `${inPct}%`;
  range.style.right = `${100 - outPct}%`;
  $("tl-in").style.left = `${inPct}%`;
  $("tl-out").style.left = `${outPct}%`;
  $("lbl-in").textContent = `in ${fmtTime(state.trimIn)}`;
  $("lbl-out").textContent = `out ${fmtTime(state.trimOut)}`;
  $("lbl-total").textContent = fmtTime(state.duration);
  (<HTMLInputElement>$("trim-in")).value = fmtTime(state.trimIn);
  (<HTMLInputElement>$("trim-out")).value = fmtTime(state.trimOut);
}

function setupTimeline() {
  const tl = $("timeline");
  let dragging: "in" | "out" | null = null;

  const posToTime = (clientX: number) => {
    const r = tl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return ratio * state.duration;
  };

  $("tl-in").addEventListener("pointerdown", (e) => {
    dragging = "in";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  $("tl-out").addEventListener("pointerdown", (e) => {
    dragging = "out";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const t = posToTime(e.clientX);
    if (dragging === "in") state.trimIn = Math.min(t, state.trimOut - 0.1);
    else state.trimOut = Math.max(t, state.trimIn + 0.1);
    renderTimeline();
    updateCmd();
  });
  window.addEventListener("pointerup", () => (dragging = null));

  tl.addEventListener("click", (e) => {
    if (state.duration === 0) return;
    const t = posToTime(e.clientX);
    const video = $<HTMLVideoElement>("video");
    video.currentTime = t;
  });

  const video = $<HTMLVideoElement>("video");
  video.addEventListener("timeupdate", () => {
    if (state.duration === 0) return;
    $("tl-playhead").style.left = `${(video.currentTime / state.duration) * 100}%`;
  });

  for (const id of ["trim-in", "trim-out"]) {
    $(id).addEventListener("change", () => {
      const tIn = parseTime((<HTMLInputElement>$("trim-in")).value);
      const tOut = parseTime((<HTMLInputElement>$("trim-out")).value);
      state.trimIn = Math.min(Math.max(0, tIn), state.duration);
      state.trimOut = Math.min(Math.max(tIn + 0.1, tOut), state.duration);
      renderTimeline();
      updateCmd();
    });
  }
}

// ---------- convert ----------

function setStatus(msg: string, kind: "" | "error" | "ok" = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = `status ${kind}`;
}

async function startConvert() {
  if (!state.file || state.converting) return;
  const { pre, post, ext } = buildArgs();
  const defaultName = `${stripExt(baseName(state.file))}_out.${ext}`;
  const outPath = await save({
    defaultPath: defaultName,
    filters: [{ name: ext, extensions: [ext] }],
  });
  if (!outPath) return;

  const args = [...pre, "-i", state.file, ...post, outPath];
  const effDuration =
    trimArgs().length > 0 ? state.trimOut - state.trimIn : state.duration;

  try {
    await invoke("start_convert", { args, duration: effDuration });
    state.converting = true;
    (<HTMLButtonElement>$("btn-convert")).disabled = true;
    $("progress-wrap").hidden = false;
    $("progress-fill").style.width = "0%";
    $("progress-label").textContent = "0%";
    setStatus("Converting…");
  } catch (e) {
    setStatus(String(e), "error");
  }
}

function setupEvents() {
  listen<{ ratio: number; out_time: number }>("convert-progress", (e) => {
    const pct = Math.round(e.payload.ratio * 100);
    $("progress-fill").style.width = `${pct}%`;
    $("progress-label").textContent = `${pct}% · ${fmtTime(e.payload.out_time)}`;
  });

  listen<{ ok: boolean; cancelled: boolean; message: string }>(
    "convert-done",
    (e) => {
      state.converting = false;
      (<HTMLButtonElement>$("btn-convert")).disabled = !state.file;
      $("progress-wrap").hidden = true;
      if (e.payload.ok) setStatus("Done.", "ok");
      else if (e.payload.cancelled) setStatus("Cancelled.");
      else setStatus(e.payload.message || "Conversion failed.", "error");
    }
  );
}

// ---------- UI wiring ----------

function setupUI() {
  // simple / advanced
  $("btn-simple").addEventListener("click", () => {
    $("app").classList.remove("is-advanced");
    $("btn-simple").classList.add("active");
    $("btn-advanced").classList.remove("active");
  });
  $("btn-advanced").addEventListener("click", () => {
    $("app").classList.add("is-advanced");
    $("btn-advanced").classList.add("active");
    $("btn-simple").classList.remove("active");
  });

  // mode nav
  document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode as Mode;
      document
        .querySelectorAll(".mode-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      document
        .querySelectorAll<HTMLElement>("[data-panel]")
        .forEach((p) => (p.hidden = p.dataset.panel !== state.mode));
      updateCmd();
    });
  });

  // filter toggles expand options
  document
    .querySelectorAll<HTMLInputElement>(".filter-toggle")
    .forEach((t) => {
      t.addEventListener("change", () => {
        document
          .querySelectorAll<HTMLElement>(`[data-for="${t.id}"]`)
          .forEach((o) => o.classList.toggle("open", t.checked));
        updateCmd();
      });
    });

  // live labels
  $("crf").addEventListener("input", () => {
    $("crf-val").textContent = (<HTMLInputElement>$("crf")).value;
    updateCmd();
  });
  $("wm-opacity").addEventListener("input", () => {
    $("wm-op-val").textContent = (<HTMLInputElement>$("wm-opacity")).value;
    updateCmd();
  });

  // any option change refreshes command preview
  document
    .querySelectorAll<HTMLElement>(".side select, .side input")
    .forEach((el) => el.addEventListener("change", updateCmd));

  $("btn-open").addEventListener("click", pickFile);
  $("btn-open-2").addEventListener("click", pickFile);
  $("btn-convert").addEventListener("click", startConvert);
  $("btn-cancel").addEventListener("click", () => invoke("cancel_convert"));

  // native file drag & drop
  getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop" && e.payload.paths.length > 0) {
      loadFile(e.payload.paths[0]);
    }
  });

  $("preview").addEventListener("dblclick", () => {
    if (!state.file) pickFile();
  });
}

async function applyCapabilities() {
  try {
    const caps = await invoke<string[]>("ffmpeg_capabilities");
    const requirements: Record<string, string> = {
      "f-watermark": "drawtext",
      "f-denoise": "hqdn3d",
    };
    for (const [id, filter] of Object.entries(requirements)) {
      if (caps.includes(filter)) continue;
      const toggle = $<HTMLInputElement>(id);
      toggle.checked = false;
      toggle.disabled = true;
      const row = toggle.closest(".filter-row") as HTMLElement | null;
      if (row) {
        row.style.opacity = "0.4";
        row.title = `Not available in this ffmpeg build (missing ${filter} filter)`;
      }
    }
  } catch {
    // ffmpeg missing entirely; surfaced on first probe/convert instead
  }
}

window.addEventListener("DOMContentLoaded", () => {
  setupUI();
  setupTimeline();
  setupEvents();
  updateCmd();
  applyCapabilities();
});
