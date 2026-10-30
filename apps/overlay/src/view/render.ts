import { createFace } from "../face/index.js";
import { LAYOUTS, type Zone } from "./layout.js";
import { createFrameLoop, type FrameClock } from "./loop.js";
import type { ViewStore } from "./store.js";
import "./view.css";

const place = (node: HTMLElement, zone: Zone) => {
  node.style.left = `${zone.x}px`;
  node.style.top = `${zone.y}px`;
  node.style.width = `${zone.width}px`;
  node.style.height = `${zone.height}px`;
  if (zone.fontSize) node.style.fontSize = `${zone.fontSize}px`;
};
const write = (node: HTMLElement, text: string) => {
  if (node.textContent !== text) node.textContent = text;
};
export function createRenderer(options: {
  root: HTMLElement;
  store: ViewStore;
  clock?: FrameClock;
  sample?: () => number;
  seed?: number;
  beforeDraw?: (nowMs: number) => void;
}) {
  const { root, store } = options;
  root.classList.add("overlay-view");
  const make = (className: string) => {
    const node = document.createElement("div");
    node.className = className;
    root.append(node);
    return node;
  };
  const bar = make("bottom-bar");
  const faceHost = make("face-host");
  const caption = make("caption plate");
  const meter = make("agreement plate");
  const dissent = make("dissent plate");
  const counter = make("counter plate");
  const question = make("question plate");
  const badge = make("ai-badge plate");
  const qr = make("qr-placeholder plate");
  const stateTag = make("state-tag plate");
  const face = createFace({ seed: options.seed ?? 1729, size: 512 });
  faceHost.append(face.element);
  let layout = "";
  const loop = createFrameLoop((now) => {
    options.beforeDraw?.(now);
    if (options.sample) store.sample(options.sample());
    const view = store.view();
    const zones = LAYOUTS[view.layout];
    root.dataset.layout = view.layout;
    root.dataset.pose = view.pose;
    if (layout !== view.layout) {
      layout = view.layout;
      for (const [node, zone] of [
        [faceHost, zones.face],
        [caption, zones.caption],
        [meter, zones.meter],
        [dissent, zones.dissent],
        [counter, zones.counter],
        [question, zones.question],
        [badge, zones.badge],
      ] as const)
        place(node, zone);
      if (zones.qr) place(qr, zones.qr);
      if (zones.bar) place(bar, zones.bar);
      bar.hidden = !zones.bar;
      qr.hidden = !zones.qr;
      stateTag.style.left = `${view.layout === "stage" ? zones.face.x + zones.face.width + 16 : zones.face.x}px`;
      stateTag.style.top = `${view.layout === "stage" ? zones.face.y : zones.face.y - 40}px`;
    }
    const line = view.caption?.line;
    const dissentText =
      view.caption?.dissent && line?.dissent && line.dissentPct !== null
        ? `${line.dissentPct}% say ${line.dissent}`
        : "";
    write(
      caption,
      line ? line.text + (view.layout === "compact" && dissentText ? ` · ${dissentText}` : "") : "",
    );
    caption.hidden = !line;
    write(meter, line ? `${line.pct}% of ${line.voices}` : "");
    meter.hidden = !line || line.voices === 0;
    write(dissent, dissentText);
    dissent.hidden = !dissentText || view.layout === "compact";
    write(counter, view.layout === "stage" ? String(view.voices) : `${view.voices} voices`);
    write(question, view.state.question ?? "");
    question.hidden = !view.state.question;
    write(badge, "AI voice");
    write(qr, `QR space\n280 x 280\ntwitch.tv/${view.channel}`);
    write(
      stateTag,
      view.pose === "muted"
        ? "Muted"
        : view.pose === "asleep"
          ? "The mob is resting"
          : "Temporary face",
    );
    face.setPose(view.pose);
    face.setMood(view.state.mood);
    face.setHype(view.state.hype?.level ?? null);
    // The placeholder demonstrates the interface; the selected rig gets the audio envelope later.
    face.setMouth(
      view.pose === "speaking" ? 0.65 : view.pose === "aside" ? 0.4 : 0,
      view.pose === "speaking" || view.pose === "aside" ? "open" : "closed",
    );
    face.update(now);
  }, options.clock);
  loop.setActive(true);
  return {
    setActive(value: boolean) {
      store.setActive(value);
      loop.setActive(value);
    },
    destroy() {
      loop.destroy();
      face.destroy();
      root.replaceChildren();
    },
  };
}
