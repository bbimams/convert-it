import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";

type Mode = "convert" | "trim" | "filters" | "gif";

interface Segment {
  in: number;
  out: number;
}

interface QueuedJob {
  input: string;
  output: string;
  pre: string[];
  post: string[];
  duration: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const state = {
  mode: "convert" as Mode,
  file: null as string | null,
  duration: 0,
  meta: "",
  hasVideo: true,
  hasAudio: true,
  segments: [] as Segment[],
  activeSeg: 0,
  converting: false,
  // multi-file export queue
  queue: [] as QueuedJob[],
  queueIndex: 0,
  queueTotal: 0,
  completedOutputs: [] as string[],
  loadToken: 0,
};

// ---------- helpers ----------

function fmtTime(s: number, decimals = 0): string {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  let out = [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
  if (decimals > 0) out += (s % 1).toFixed(decimals).slice(1);
  return out;
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

function sortedSegments(): Segment[] {
  return [...state.segments].sort((a, b) => a.in - b.in);
}

function trimActive(): boolean {
  if (state.duration === 0 || state.segments.length === 0) return false;
  const enabled =
    state.mode === "trim" ||
    state.mode === "gif" ||
    (<HTMLInputElement>$("trim-enabled")).checked;
  if (!enabled) return false;
  const segs = state.segments;
  return !(segs.length === 1 && segs[0].in <= 0 && segs[0].out >= state.duration);
}

function trimmedDuration(): number {
  return trimActive()
    ? state.segments.reduce((acc, s) => acc + (s.out - s.in), 0)
    : state.duration;
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

interface BuiltArgs {
  pre: string[];
  post: string[];
  ext: string;
}

interface SegArgs {
  pre: string[];
  post: string[];
}

// Encoding/output args for a single input pass. `seg` limits to one segment;
// omitted = no trim (used when concat handles segmentation).
function buildArgs(seg?: Segment): BuiltArgs {
  const pre = seg
    ? ["-ss", fmtTime(seg.in, 3), "-to", fmtTime(seg.out, 3)]
    : [];
  const post: string[] = [];

  if (state.mode === "gif") {
    const fps = (<HTMLSelectElement>$("gif-fps")).value;
    const width = (<HTMLInputElement>$("gif-width")).value || "480";
    const palette = (<HTMLInputElement>$("gif-palette")).checked;
    const chain = [
      ...buildFilters(),
      `fps=${fps}`,
      `scale=${width}:-1:flags=lanczos`,
    ].join(",");
    const vf = palette
      ? `${chain},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`
      : chain;
    post.push("-vf", vf, "-loop", "0");
    return { pre, post, ext: "gif" };
  }

  const fmt = (<HTMLSelectElement>$("out-format")).value;
  const filters = buildFilters();

  if (fmt === "mp3" || fmt === "wav") {
    post.push("-vn");
    if (fmt === "mp3")
      post.push("-c:a", "libmp3lame", "-b:a", (<HTMLSelectElement>$("abitrate")).value);
    return { pre, post, ext: fmt };
  }

  let vcodec = (<HTMLSelectElement>$("vcodec")).value;
  const trimCopy =
    state.mode === "trim" && (<HTMLInputElement>$("trim-copy")).checked;

  if (trimCopy && filters.length === 0) {
    post.push("-c", "copy");
    return { pre, post, ext: fmt };
  }

  // stream copy is impossible once filters apply — fall back to h.264
  if (vcodec === "copy" && filters.length) vcodec = "libx264";
  if (filters.length) post.push("-vf", filters.join(","));
  post.push("-c:v", vcodec);
  if (vcodec !== "copy") {
    post.push("-crf", (<HTMLInputElement>$("crf")).value);
    if (vcodec === "libx264" || vcodec === "libx265")
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

// Joins multiple segments into one output with trim+concat filter_complex.
function buildConcatArgs(segs: Segment[]): SegArgs {
  const fmt = (<HTMLSelectElement>$("out-format")).value;
  const audioOnly = fmt === "mp3" || fmt === "wav";
  const videoOut = !audioOnly && state.hasVideo;
  const audio =
    state.hasAudio &&
    (audioOnly || (<HTMLSelectElement>$("acodec")).value !== "none");

  const parts: string[] = [];
  const pads: string[] = [];
  segs.forEach((s, i) => {
    if (videoOut) {
      parts.push(
        `[0:v]trim=start=${s.in.toFixed(3)}:end=${s.out.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`
      );
      pads.push(`[v${i}]`);
    }
    if (audio) {
      parts.push(
        `[0:a]atrim=start=${s.in.toFixed(3)}:end=${s.out.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
      );
      if (videoOut) pads[pads.length - 1] += `[a${i}]`;
      else pads.push(`[a${i}]`);
    }
  });
  parts.push(
    `${pads.join("")}concat=n=${segs.length}:v=${videoOut ? 1 : 0}:a=${audio ? 1 : 0}${videoOut ? "[vo]" : ""}${audio ? "[ao]" : ""}`
  );

  const extra = buildFilters();
  let mapV = "[vo]";
  if (videoOut && extra.length) {
    parts.push(`[vo]${extra.join(",")}[vf]`);
    mapV = "[vf]";
  }

  const post: string[] = ["-filter_complex", parts.join(";")];
  if (videoOut) {
    post.push("-map", mapV);
    const vcodec = (<HTMLSelectElement>$("vcodec")).value;
    const enc = vcodec === "copy" ? "libx264" : vcodec; // copy impossible after filtering
    post.push("-c:v", enc, "-crf", (<HTMLInputElement>$("crf")).value);
    if (enc === "libx264" || enc === "libx265")
      post.push("-preset", (<HTMLSelectElement>$("preset")).value);
  }
  if (audio) {
    post.push("-map", "[ao]");
    if (fmt === "mp3") post.push("-c:a", "libmp3lame");
    else if (fmt === "wav") post.push("-c:a", "pcm_s16le");
    else {
      const acodec = (<HTMLSelectElement>$("acodec")).value;
      post.push("-c:a", acodec === "copy" ? "aac" : acodec);
    }
    if (fmt !== "wav") post.push("-b:a", (<HTMLSelectElement>$("abitrate")).value);
  }
  return { pre: [], post };
}

function multiFileExport(): boolean {
  return (
    state.mode === "trim" &&
    trimActive() &&
    sortedSegments().length > 1 &&
    (<HTMLSelectElement>$("trim-export")).value === "multi"
  );
}

function multiSegmentJoin(): boolean {
  return (
    trimActive() &&
    state.segments.length > 1 &&
    state.mode !== "gif" &&
    !multiFileExport()
  );
}

function updateCmd() {
  const input = state.file ? baseName(state.file) : "input.mp4";
  const segs = sortedSegments();
  let parts: string[];

  if (multiSegmentJoin()) {
    const ext = (<HTMLSelectElement>$("out-format")).value;
    const { post } = buildConcatArgs(segs);
    parts = ["ffmpeg", "-i", input, ...post, `${stripExt(input)}_out.${ext}`];
  } else if (multiFileExport()) {
    const { pre, post, ext } = buildArgs(segs[0]);
    parts = [
      "ffmpeg", ...pre, "-i", input, ...post,
      `${stripExt(input)}_seg1.${ext}`,
      `(×${segs.length} files)`,
    ];
  } else {
    const seg = trimActive() ? segs[0] : undefined;
    const { pre, post, ext } = buildArgs(seg);
    parts = ["ffmpeg", ...pre, "-i", input, ...post, `${stripExt(input)}_out.${ext}`];
  }
  $("cmd").textContent = parts
    .map((p) => (/[\s'";\[\]]/.test(p) && !p.startsWith("(") ? `"${p}"` : p))
    .join(" ");
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
  const video = $<HTMLVideoElement>("video");
  const loadToken = ++state.loadToken;
  setStatus("Reading media information…");
  (<HTMLButtonElement>$("btn-convert")).disabled = true;

  // Stop the WebView from decoding the previous file while ffprobe reads the
  // new one. Metadata-only preload avoids buffering a large video on open.
  video.pause();
  video.removeAttribute("src");
  video.load();

  try {
    const info = await invoke<ProbeInfo>("probe_media", { path });
    if (loadToken !== state.loadToken) return;

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
    state.segments = [{ in: 0, out: dur }];
    state.hasVideo = !!v;
    state.hasAudio = !!a;
    state.activeSeg = 0;
    state.meta = bits.join(" · ");

    video.preload = "metadata";
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
    if (loadToken !== state.loadToken) return;
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

// ---------- timeline & segments ----------

function renderTimeline() {
  if (state.duration === 0) return;
  const tl = $("timeline");
  tl.querySelectorAll(".tl-range, .tl-handle").forEach((n) => n.remove());

  state.segments.forEach((seg, i) => {
    const inPct = (seg.in / state.duration) * 100;
    const outPct = (seg.out / state.duration) * 100;

    const range = document.createElement("div");
    range.className = "tl-range" + (i === state.activeSeg ? " active" : "");
    range.style.left = `${inPct}%`;
    range.style.right = `${100 - outPct}%`;
    range.addEventListener("pointerdown", () => {
      state.activeSeg = i;
      renderTimeline();
    });
    tl.appendChild(range);

    for (const side of ["in", "out"] as const) {
      const h = document.createElement("div");
      h.className = "tl-handle" + (i === state.activeSeg ? " active" : "");
      h.style.left = `${side === "in" ? inPct : outPct}%`;
      h.dataset.seg = String(i);
      h.dataset.side = side;
      h.title = `Segment ${i + 1} ${side}`;
      tl.appendChild(h);
    }
  });

  if (!tl.querySelector(".tl-playhead")) {
    const playhead = document.createElement("div");
    playhead.className = "tl-playhead";
    tl.appendChild(playhead);
  }

  const segs = sortedSegments();
  $("lbl-segments").textContent = segs
    .map((s) => `${fmtTime(s.in)}–${fmtTime(s.out)}`)
    .join("  ");
  $("lbl-total").textContent = fmtTime(state.duration);
  renderSegList();
}

function renderSegList() {
  const list = $("seg-list");
  list.innerHTML = "";
  state.segments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "seg-row" + (i === state.activeSeg ? " active" : "");

    const label = document.createElement("button");
    label.className = "seg-label";
    label.textContent = `${i + 1}`;
    label.setAttribute("aria-label", `Select segment ${i + 1}`);
    label.addEventListener("click", () => {
      state.activeSeg = i;
      renderTimeline();
    });

    const mkField = (side: "in" | "out") => {
      const field = document.createElement("input");
      field.type = "text";
      field.value = fmtTime(seg[side]);
      field.spellcheck = false;
      field.setAttribute("aria-label", `Segment ${i + 1} ${side}`);
      field.addEventListener("change", () => {
        const t = parseTime(field.value);
        if (side === "in") seg.in = Math.min(Math.max(0, t), seg.out - 0.1);
        else seg.out = Math.min(Math.max(seg.in + 0.1, t), state.duration);
        renderTimeline();
        updateCmd();
      });
      return field;
    };

    const del = document.createElement("button");
    del.className = "seg-del";
    del.innerHTML = '<i class="ti ti-x" aria-hidden="true"></i>';
    del.setAttribute("aria-label", `Remove segment ${i + 1}`);
    del.disabled = state.segments.length === 1;
    del.addEventListener("click", () => {
      state.segments.splice(i, 1);
      state.activeSeg = Math.min(state.activeSeg, state.segments.length - 1);
      renderTimeline();
      updateCmd();
    });

    row.append(label, mkField("in"), mkField("out"), del);
    list.appendChild(row);
  });
}

function addSegment() {
  if (state.duration === 0) return;
  const segs = sortedSegments();
  // place the new segment in the largest gap between existing ones
  let start = 0;
  let bestGap = 0;
  let cursor = 0;
  for (const s of segs) {
    if (s.in - cursor > bestGap) {
      bestGap = s.in - cursor;
      start = cursor;
    }
    cursor = Math.max(cursor, s.out);
  }
  if (state.duration - cursor > bestGap) {
    bestGap = state.duration - cursor;
    start = cursor;
  }
  if (bestGap < 0.5) {
    // no gap — split the largest segment in half instead
    const largest = state.segments.reduce((a, b) =>
      b.out - b.in > a.out - a.in ? b : a
    );
    if (largest.out - largest.in < 1) {
      setStatus("No room for another segment — shrink existing ones first.");
      return;
    }
    const mid = (largest.in + largest.out) / 2;
    const end = largest.out;
    largest.out = mid;
    state.segments.push({ in: mid, out: end });
    state.activeSeg = state.segments.length - 1;
    renderTimeline();
    updateCmd();
    return;
  }
  const len = Math.min(bestGap, Math.max(1, state.duration * 0.1));
  state.segments.push({ in: start, out: start + len });
  state.activeSeg = state.segments.length - 1;
  renderTimeline();
  updateCmd();
}

function setupTimeline() {
  const tl = $("timeline");
  let dragging: { seg: number; side: "in" | "out" } | null = null;

  const posToTime = (clientX: number) => {
    const r = tl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return ratio * state.duration;
  };

  tl.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains("tl-handle")) {
      dragging = {
        seg: Number(t.dataset.seg),
        side: t.dataset.side as "in" | "out",
      };
      state.activeSeg = dragging.seg;
      t.setPointerCapture(e.pointerId);
      e.stopPropagation();
    }
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const seg = state.segments[dragging.seg];
    const t = posToTime(e.clientX);
    if (dragging.side === "in") seg.in = Math.min(t, seg.out - 0.1);
    else seg.out = Math.max(t, seg.in + 0.1);
    renderTimeline();
    updateCmd();
  });
  window.addEventListener("pointerup", () => (dragging = null));

  tl.addEventListener("click", (e) => {
    if (state.duration === 0) return;
    if ((e.target as HTMLElement).classList.contains("tl-handle")) return;
    $<HTMLVideoElement>("video").currentTime = posToTime(e.clientX);
  });

  const video = $<HTMLVideoElement>("video");
  video.addEventListener("timeupdate", () => {
    if (state.duration === 0) return;
    const playhead = tl.querySelector<HTMLElement>(".tl-playhead");
    if (playhead)
      playhead.style.left = `${(video.currentTime / state.duration) * 100}%`;
  });

  $("btn-add-seg").addEventListener("click", addSegment);
}

// ---------- convert ----------

function setStatus(msg: string, kind: "" | "error" | "ok" = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function beginJob() {
  state.converting = true;
  state.completedOutputs = state.queue.map((job) => job.output);
  const completionDialog = $<HTMLDialogElement>("completion-dialog");
  if (completionDialog.open) completionDialog.close();
  (<HTMLButtonElement>$("btn-convert")).disabled = true;
  $("progress-wrap").hidden = false;
  $("progress-fill").style.width = "0%";
  $("progress-label").textContent = "0%";
}

function showCompletionDialog() {
  const outputs = state.completedOutputs;
  const firstOutput = outputs[0];
  if (!firstOutput) return;

  $("completion-message").textContent =
    outputs.length > 1
      ? `${outputs.length} files were converted successfully.`
      : "Your file was converted successfully.";
  $("completion-path").textContent =
    outputs.length > 1 ? `${firstOutput} (+${outputs.length - 1} more)` : firstOutput;
  $<HTMLDialogElement>("completion-dialog").showModal();
}

function endJobs() {
  state.converting = false;
  state.queue = [];
  (<HTMLButtonElement>$("btn-convert")).disabled = !state.file;
  $("progress-wrap").hidden = true;
}

async function runNextQueued(): Promise<boolean> {
  const job = state.queue[0];
  if (!job) return false;
  await invoke("start_convert", {
    input: job.input,
    output: job.output,
    pre: job.pre,
    post: job.post,
    duration: job.duration,
  });
  state.queue.shift();
  state.queueIndex += 1;
  setStatus(
    state.queueTotal > 1
      ? `Converting segment ${state.queueIndex}/${state.queueTotal}…`
      : "Converting…"
  );
  return true;
}

async function startConvert() {
  if (!state.file || state.converting) return;

  // preflight: impossible stream combinations
  const fmt = (<HTMLSelectElement>$("out-format")).value;
  if ((fmt === "mp3" || fmt === "wav") && !state.hasAudio) {
    setStatus("Source has no audio stream — cannot export audio-only format.", "error");
    return;
  }
  if (state.mode === "gif" && !state.hasVideo) {
    setStatus("Source has no video stream — cannot export GIF.", "error");
    return;
  }
  if (!state.hasVideo && !state.hasAudio) {
    setStatus("Source has no audio or video streams — nothing to convert.", "error");
    return;
  }

  const segs = sortedSegments();
  const input = state.file;

  if (multiSegmentJoin()) {
    const ext = (<HTMLSelectElement>$("out-format")).value;
    const outPath = await save({
      defaultPath: `${stripExt(baseName(state.file))}_out.${ext}`,
      filters: [{ name: ext, extensions: [ext] }],
    });
    if (!outPath) return;
    state.queue = [
      {
        pre: [],
        post: buildConcatArgs(segs).post,
        input,
        output: outPath,
        duration: trimmedDuration(),
      },
    ];
  } else if (multiFileExport()) {
    // one save dialog; numbered siblings derive from it
    const { ext } = buildArgs(segs[0]);
    const outPath = await save({
      defaultPath: `${stripExt(baseName(state.file))}_seg1.${ext}`,
      filters: [{ name: ext, extensions: [ext] }],
    });
    if (!outPath) return;
    const base = outPath.replace(/\.[^.]+$/, "").replace(/_seg1$/, "");
    state.queue = segs.map((seg, i) => {
      const { pre, post } = buildArgs(seg);
      return {
        pre,
        post,
        input,
        output: `${base}_seg${i + 1}.${ext}`,
        duration: seg.out - seg.in,
      };
    });
  } else {
    const seg = trimActive() ? segs[0] : undefined;
    const { pre, post, ext } = buildArgs(seg);
    const outPath = await save({
      defaultPath: `${stripExt(baseName(state.file))}_out.${ext}`,
      filters: [{ name: ext, extensions: [ext] }],
    });
    if (!outPath) return;
    state.queue = [
      {
        pre,
        post,
        input,
        output: outPath,
        duration: seg ? seg.out - seg.in : state.duration,
      },
    ];
  }

  state.queueTotal = state.queue.length;
  state.queueIndex = 0;
  try {
    await invoke("reset_completed_outputs");
    beginJob();
    await runNextQueued();
  } catch (e) {
    endJobs();
    setStatus(String(e), "error");
  }
}

function setupEvents() {
  listen<{ ratio: number; out_time: number }>("convert-progress", (e) => {
    const done = state.queueIndex - 1;
    const overall = (done + e.payload.ratio) / Math.max(1, state.queueTotal);
    const pct = Math.round(overall * 100);
    $("progress-fill").style.width = `${pct}%`;
    $("progress-label").textContent = `${pct}% · ${fmtTime(e.payload.out_time)}`;
  });

  listen<{ ok: boolean; cancelled: boolean; message: string }>(
    "convert-done",
    async (e) => {
      if (e.payload.cancelled) {
        endJobs();
        setStatus("Cancelled.");
        return;
      }
      if (!e.payload.ok) {
        endJobs();
        setStatus(e.payload.message || "Conversion failed.", "error");
        return;
      }
      try {
        if (await runNextQueued()) return;
      } catch (err) {
        endJobs();
        setStatus(String(err), "error");
        return;
      }
      endJobs();
      setStatus("");
      showCompletionDialog();
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

  // hide the Simple/Advanced toggle on tabs with no advanced-only options
  const updateSegVisibility = () => {
    const panel = document.querySelector<HTMLElement>(
      `[data-panel="${state.mode}"]`
    );
    const hasAdvanced = !!panel?.querySelector(".adv-only");
    const seg = document.querySelector(".seg") as HTMLElement;
    seg.style.display = hasAdvanced ? "" : "none";
  };
  updateSegVisibility();

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
      updateSegVisibility();
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

  const completionDialog = $<HTMLDialogElement>("completion-dialog");
  completionDialog.addEventListener("cancel", () => completionDialog.close());
  $("btn-open-output").addEventListener("click", async () => {
    const output = state.completedOutputs[0];
    if (!output) return;
    try {
      await invoke("open_output", { path: output });
      completionDialog.close();
    } catch (e) {
      setStatus(String(e), "error");
    }
  });
  $("btn-show-output").addEventListener("click", async () => {
    const output = state.completedOutputs[0];
    if (!output) return;
    try {
      await invoke("show_output", { path: output });
      completionDialog.close();
    } catch (e) {
      setStatus(String(e), "error");
    }
  });

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
    const requirements: Record<string, string[]> = {
      "f-watermark": ["drawtext"],
      "f-denoise": ["hqdn3d"],
      "gif-palette": ["palettegen", "paletteuse"],
    };
    for (const [id, filters] of Object.entries(requirements)) {
      const missing = filters.filter((f) => !caps.includes(f));
      if (missing.length === 0) continue;
      const toggle = $<HTMLInputElement>(id);
      toggle.checked = false;
      toggle.disabled = true;
      const row = toggle.closest(".filter-row, .check") as HTMLElement | null;
      if (row) {
        row.style.opacity = "0.4";
        row.title = `Not available in this ffmpeg build (missing ${missing.join(", ")})`;
      }
    }
    updateCmd();
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
