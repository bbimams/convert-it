// UI-state verification harness: real index.html + main.ts against a mocked
// Tauri bridge. Run with `bun test verify/ui.test.ts`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { test, expect, beforeAll, mock } from "bun:test";

GlobalRegistrator.register();

interface InvokeCall {
  cmd: string;
  args:
    | {
        input?: string;
        output?: string;
        pre?: string[];
        post?: string[];
        duration?: number;
        path?: string;
      }
    | undefined;
}
const invoked: InvokeCall[] = [];
const openedOutputs: string[] = [];
const shownOutputs: string[] = [];
let probeResponse: Promise<unknown> | undefined;
let doneListener: ((e: { payload: unknown }) => void) | undefined;
// flush pending microtasks from async click handlers (no wall-clock timers)
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

mock.module("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: async (cmd: string, args?: InvokeCall["args"]) => {
    invoked.push({ cmd, args });
    if (cmd === "probe_media") {
      if (probeResponse) return probeResponse;
      return {
        format: { duration: "10.0" },
        streams: [
          { codec_type: "video", codec_name: "h264", width: 640, height: 360 },
          { codec_type: "audio", codec_name: "aac" },
        ],
      };
    }
    if (cmd === "ffmpeg_capabilities")
      return ["hqdn3d", "palettegen", "paletteuse"];
    if (cmd === "open_output" && args?.path) openedOutputs.push(args.path);
    if (cmd === "show_output" && args?.path) shownOutputs.push(args.path);
    return null;
  },
}));
mock.module("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "convert-done") doneListener = cb;
    return () => {};
  },
}));
mock.module("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => {} }),
}));
mock.module("@tauri-apps/plugin-dialog", () => ({
  open: async () => "/tmp/mock-input.mp4",
  save: async () => "/tmp/mock-out_seg1.mp4",
}));

const seg = () => document.querySelector(".seg") as HTMLElement;
const click = (sel: string) =>
  (document.querySelector(sel) as HTMLElement).click();
const modeBtn = (m: string) => `.mode-btn[data-mode="${m}"]`;
const visible = (el: HTMLElement) => el.style.display !== "none";
const startCalls = () => invoked.filter((c) => c.cmd === "start_convert");

beforeAll(async () => {
  const html = await Bun.file("index.html").text();
  document.write(
    html.replace(/<script[^>]*><\/script>/, "").replace(/<link[^>]*>/g, "")
  );
  // dynamic import required: mock.module registrations above must be in place
  // before main.ts resolves its @tauri-apps imports
  await import("../src/main.ts");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  await flush();
});

test("Convert tab hides Simple/Advanced toggle", () => {
  expect(visible(seg())).toBe(false);
});

test("Trim, Filters, GIF tabs show the toggle", () => {
  for (const m of ["trim", "filters", "gif"]) {
    click(modeBtn(m));
    expect(visible(seg())).toBe(true);
  }
  click(modeBtn("convert"));
  expect(visible(seg())).toBe(false);
});

test("file probing keeps the UI responsive and preview metadata-only", async () => {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  probeResponse = promise;

  click("#btn-open");
  await flush();

  expect(document.getElementById("status")!.textContent).toBe(
    "Reading media information…"
  );
  expect((document.getElementById("btn-convert") as HTMLButtonElement).disabled).toBe(true);

  resolve({
    format: { duration: "10.0" },
    streams: [
      { codec_type: "video", codec_name: "h264", width: 640, height: 360 },
      { codec_type: "audio", codec_name: "aac" },
    ],
  });
  await flush();
  probeResponse = undefined;

  const video = document.getElementById("video") as HTMLVideoElement;
  expect(video.preload).toBe("metadata");
  expect(video.src).toContain("asset:///tmp/mock-input.mp4");
});

test("loading a file creates one full-length segment", async () => {
  click("#btn-open");
  await flush();
  expect(document.querySelectorAll("#seg-list .seg-row").length).toBe(1);
  const inputs = document.querySelectorAll<HTMLInputElement>("#seg-list input");
  expect(inputs[0].value).toBe("00:00:00");
  expect(inputs[1].value).toBe("00:00:10");
});

test("add + edit + delete segments", () => {
  click(modeBtn("trim"));
  click("#btn-add-seg");
  expect(document.querySelectorAll("#seg-list .seg-row").length).toBe(2);

  // segment 1 -> 0-3, segment 2 -> 5-8 (re-query rows after each re-render)
  const setField = (row: number, idx: number, v: string) => {
    const rows = document.querySelectorAll("#seg-list .seg-row");
    const f = rows[row].querySelectorAll<HTMLInputElement>("input")[idx];
    f.value = v;
    f.dispatchEvent(new Event("change"));
  };
  setField(0, 1, "00:00:03");
  setField(1, 0, "00:00:05");
  setField(1, 1, "00:00:08");

  const labels = document.getElementById("lbl-segments")!.textContent!;
  expect(labels).toContain("00:00:00–00:00:03");
  expect(labels).toContain("00:00:05–00:00:08");

  // delete third segment after adding it
  click("#btn-add-seg");
  expect(document.querySelectorAll("#seg-list .seg-row").length).toBe(3);
  (document.querySelectorAll("#seg-list .seg-del")[2] as HTMLElement).click();
  expect(document.querySelectorAll("#seg-list .seg-row").length).toBe(2);
});

test("single-file export builds concat command", () => {
  (document.getElementById("trim-export") as HTMLSelectElement).value =
    "single";
  document.getElementById("trim-export")!.dispatchEvent(new Event("change"));
  const cmd = document.getElementById("cmd")!.textContent!;
  expect(cmd).toContain("filter_complex");
  expect(cmd).toContain("concat=n=2:v=1:a=1");
  expect(cmd).toContain("atrim=start=5.000:end=8.000");
});

test("multi-file export previews per-segment command", () => {
  (document.getElementById("trim-export") as HTMLSelectElement).value =
    "multi";
  document.getElementById("trim-export")!.dispatchEvent(new Event("change"));
  const cmd = document.getElementById("cmd")!.textContent!;
  expect(cmd).toContain("-ss 00:00:00.000 -to 00:00:03.000");
  expect(cmd).toContain("_seg1.");
  expect(cmd).toContain("(×2 files)");
});

test("multi-file convert queues both segments with numbered outputs", async () => {
  invoked.length = 0;
  openedOutputs.length = 0;
  shownOutputs.length = 0;
  click("#btn-convert");
  await flush();
  expect(startCalls().length).toBe(1);
  expect(startCalls()[0].args?.output).toBe("/tmp/mock-out_seg1.mp4");
  expect(startCalls()[0].args?.pre).toContain("-ss");
  expect(startCalls()[0].args?.duration).toBe(3);

  // finishing job 1 must auto-start job 2
  doneListener!({ payload: { ok: true, cancelled: false, message: "" } });
  await flush();
  expect(startCalls().length).toBe(2);
  expect(startCalls()[1].args?.output).toBe("/tmp/mock-out_seg2.mp4");
  expect(startCalls()[1].args?.duration).toBe(3);

  // finishing job 2 ends the queue
  doneListener!({ payload: { ok: true, cancelled: false, message: "" } });
  await flush();
  const dialog = document.getElementById("completion-dialog") as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(document.getElementById("completion-message")!.textContent).toContain("2 files");
  expect(document.getElementById("completion-path")!.textContent).toContain("mock-out_seg1.mp4");
});

test("completion popup opens or reveals the first output", async () => {
  click("#btn-open-output");
  await flush();
  expect(openedOutputs).toEqual(["/tmp/mock-out_seg1.mp4"]);

  const dialog = document.getElementById("completion-dialog") as HTMLDialogElement;
  dialog.showModal();
  click("#btn-show-output");
  await flush();
  expect(shownOutputs).toEqual(["/tmp/mock-out_seg1.mp4"]);
});

test("cancellation invokes cancel and stops the queue", async () => {
  invoked.length = 0;
  click("#btn-convert");
  await flush();
  click("#btn-cancel");
  expect(invoked.some((c) => c.cmd === "cancel_convert")).toBe(true);
  doneListener!({
    payload: { ok: false, cancelled: true, message: "Cancelled" },
  });
  await flush();
  expect(document.getElementById("status")!.textContent).toContain("Cancelled");
  expect(startCalls().length).toBe(1); // no further job after cancel
});

test("copy codec with active filters forces re-encode", () => {
  click(modeBtn("convert"));
  (document.getElementById("vcodec") as HTMLSelectElement).value = "copy";
  document.getElementById("vcodec")!.dispatchEvent(new Event("change"));
  (document.getElementById("f-crop") as HTMLInputElement).checked = true;
  document.getElementById("f-crop")!.dispatchEvent(new Event("change"));
  const cmd = document.getElementById("cmd")!.textContent!;
  expect(cmd).toContain("-c:v libx264");
  expect(cmd).toContain("crop=");
  (document.getElementById("f-crop") as HTMLInputElement).checked = false;
  (document.getElementById("vcodec") as HTMLSelectElement).value = "libx264";
});

test("vp9 export omits the x264/x265 preset option", () => {
  click(modeBtn("convert"));
  (document.getElementById("vcodec") as HTMLSelectElement).value = "libvpx-vp9";
  document.getElementById("vcodec")!.dispatchEvent(new Event("change"));
  const cmd = document.getElementById("cmd")!.textContent!;
  expect(cmd).toContain("-c:v libvpx-vp9");
  expect(cmd).not.toContain("-preset");
});

test("GIF export includes active filters in its chain", () => {
  click(modeBtn("gif"));
  (document.getElementById("f-crop") as HTMLInputElement).checked = true;
  document.getElementById("f-crop")!.dispatchEvent(new Event("change"));
  const cmd = document.getElementById("cmd")!.textContent!;
  expect(cmd).toContain("-vf");
  expect(cmd).toContain("crop=");
  expect(cmd).toContain("fps=");
  (document.getElementById("f-crop") as HTMLInputElement).checked = false;
});
