import { formatVoiceCount, voiceLabel } from "../../../../packages/core/src/voice-count.js";
import { createFace } from "../face/index.js";
import { LAYOUTS, type Zone } from "./layout.js";
import { createLipSync, particleGaze } from "./lip-sync.js";
import { createFrameLoop, type FrameClock } from "./loop.js";
import { createParticleCanvas } from "./particle-canvas.js";
import { createChannelQr } from "./qr.js";
import type { ViewStore } from "./store.js";
import { captionWords, countUp, dissentCopy } from "./text.js";
import "./view.css";

const place = (node: HTMLElement, zone: Zone) => {
  node.style.left = `${String(zone.x)}px`;
  node.style.top = `${String(zone.y)}px`;
  node.style.width = `${String(zone.width)}px`;
  node.style.height = `${String(zone.height)}px`;
  if (zone.fontSize) node.style.fontSize = `${String(zone.fontSize)}px`;
};
const write = (node: HTMLElement, text: string) => {
  if (node.textContent === text) return false;
  node.textContent = text;
  return true;
};
export function fitPlate(node: HTMLElement, zone: Zone, lines = 3) {
  const start = zone.fontSize;
  let size = start;
  node.style.fontSize = `${String(size)}px`;
  // Font metrics and line wrapping are measured only when text/layout changes.
  while (
    size > 12 &&
    (node.scrollWidth > zone.width + 1 ||
      node.scrollHeight > zone.height + 1 ||
      node.scrollHeight > size * 1.2 * lines + 25)
  ) {
    size--;
    node.style.fontSize = `${String(size)}px`;
  }
  node.dataset.fittedSize = String(size);
}
export function createRenderer(options: {
  root: HTMLElement;
  store: ViewStore;
  clock?: FrameClock;
  sample?: () => number;
  lowBand?: () => number;
  seed?: number;
  harness?: boolean;
  beforeDraw?: (nowMs: number) => void;
}) {
  const { root, store } = options;
  root.classList.add("overlay-view");
  const make = (className: string, parent: HTMLElement = root) => {
    const node = document.createElement("div");
    node.className = className;
    parent.append(node);
    return node;
  };
  const slot = (className: string) => {
    const host = make("text-slot");
    const plate = make(`${className} plate`, host);
    return { host, plate };
  };
  const bar = make("bottom-bar");
  const faceHost = make("face-host");
  const caption = slot("caption");
  const lead = make("caption-lead", caption.plate);
  const wordsHost = make("caption-words", caption.plate);
  const compactAside = document.createElement("span");
  compactAside.className = "compact-dissent";
  const meter = slot("agreement");
  const dissent = slot("dissent");
  const counter = slot("counter");
  const counterNumber = make("counter-number", counter.plate);
  const counterLabel = make("counter-label", counter.plate);
  const question = slot("question");
  const badge = slot("ai-badge");
  const join = slot("join-hint");
  const bubble = slot("preview-bubble");
  const raid = slot("raid-banner");
  const hype = slot("hype-chip");
  const stateTag = slot("state-tag");
  const qr = make("channel-qr");
  const qrLabel = make("qr-label", qr);
  const face = createFace({ seed: options.seed ?? 1729, size: 512 });
  faceHost.append(face.element);
  const lips = createLipSync();
  const particles = createParticleCanvas(root, options.seed ?? 1729);
  write(badge.plate, "AI voice");
  write(bubble.plate, "\u2026");
  let qrChannel = "";
  let layout = "";
  let captionKey = "";
  let wordNodes: HTMLSpanElement[] = [];
  let fitted = false;
  let alive = true;
  let renderedFrames = 0;
  void document.fonts.ready.then(() => {
    if (alive) {
      fitted = false;
      particles.invalidate();
    }
  });
  const loop = createFrameLoop((now, dt) => {
    options.beforeDraw?.(now);
    if (options.sample) store.sample(options.sample());
    const view = store.view();
    const zones = LAYOUTS[view.layout];
    particles.draw(
      now,
      dt,
      zones.particles,
      {
        x: zones.face.x + zones.face.width * 0.5,
        y: zones.face.y + zones.face.height * (344 / 512),
      },
      view.particles,
    );
    root.dataset.frame = String(++renderedFrames);
    root.dataset.rms = view.rms.toFixed(4);
    root.dataset.layout = view.layout;
    root.dataset.pose = view.pose;
    const changedLayout = layout !== view.layout;
    if (changedLayout) {
      layout = view.layout;
      fitted = false;
      place(faceHost, zones.face);
      for (const [node, zone] of [
        [caption.host, zones.caption],
        [meter.host, zones.meter],
        [dissent.host, zones.dissent],
        [counter.host, zones.counter],
        [question.host, zones.question],
        [badge.host, zones.badge],
      ] as const)
        place(node, zone);
      if (zones.qr) place(qr, zones.qr);
      if (zones.bar) place(bar, zones.bar);
      bar.hidden = !zones.bar;
      qr.hidden = !zones.qr;
      place(bubble.host, {
        x: zones.face.x + zones.face.width - 18,
        y: zones.face.y + 40,
        width: 100,
        height: 70,
        fontSize: 48,
      });
      place(stateTag.host, {
        x: view.layout === "stage" ? zones.face.x + zones.face.width + 16 : zones.face.x,
        y: view.layout === "stage" ? zones.face.y : Math.max(zones.margin, zones.face.y - 55),
        width: view.layout === "stage" ? 280 : Math.max(220, zones.face.width),
        height: 48,
        fontSize: view.layout === "compact" ? 18 : 22,
      });
      place(
        join.host,
        view.layout === "stage"
          ? {
              x: zones.counter.x,
              y: zones.counter.y + zones.counter.height + 12,
              width: zones.counter.width,
              height: 60,
              fontSize: 28,
            }
          : zones.caption,
      );
      place(raid.host, { x: 360, y: 184, width: 1200, height: 96, fontSize: 42 });
      place(hype.host, { x: 1460, y: 48, width: 396, height: 80, fontSize: 28 });
    }
    if (qrChannel !== view.channel) {
      qrChannel = view.channel;
      qr.querySelector("svg")?.remove();
      qr.prepend(createChannelQr(view.channel));
      qr.dataset.url = `https://twitch.tv/${view.channel}`;
      write(qrLabel, `twitch.tv/${view.channel}`);
    }
    const visible = view.caption;
    const line = visible?.line;
    const aside = visible?.dissent
      ? dissentCopy(line?.dissentPct ?? null, line?.dissent ?? null)
      : "";
    const meanwhile = !!line && !!view.state.question && !line.answersQuestion;
    const key = line ? `${line.text}|${aside}|${String(meanwhile)}|${layout}` : "";
    if (key !== captionKey) {
      captionKey = key;
      fitted = false;
      wordsHost.replaceChildren();
      wordNodes = captionWords(line?.text ?? "").map((word) => {
        const span = document.createElement("span");
        span.className = "caption-word";
        span.textContent = word;
        wordsHost.append(span);
        return span;
      });
      if (layout === "compact" && aside) {
        compactAside.textContent = ` \u00b7 ${aside}`;
        wordsHost.append(compactAside);
      }
      write(lead, meanwhile ? "Meanwhile, chat says" : "");
      lead.hidden = !meanwhile;
    }
    caption.host.hidden = !line;
    for (let i = 0; i < wordNodes.length; i++)
      wordNodes[i]?.classList.toggle("is-current", i === visible?.highlighted);
    const pct = countUp(line?.pct ?? 0, visible?.ageMs ?? 0);
    const voices = countUp(line?.voices ?? 0, visible?.ageMs ?? 0);
    const meterChanged = write(meter.plate, `${String(pct)}% of ${formatVoiceCount(voices)}`);
    meter.host.hidden = !line || line.voices === 0;
    counter.host.hidden = !meter.host.hidden;
    meter.plate.dataset.pct = String(line?.pct ?? 0);
    const dissentChanged = write(dissent.plate, aside);
    dissent.host.hidden = !aside || layout === "compact";
    write(counterNumber, String(view.voices));
    write(counterLabel, voiceLabel(view.voices));
    const questionChanged = write(question.plate, view.state.question ?? "");
    question.host.hidden = !view.state.question;
    write(join.plate, "Type in chat to join");
    join.host.hidden =
      view.state.step !== "listening" ||
      view.pose !== "idle" ||
      (layout !== "stage" && view.voices >= 2);
    write(
      stateTag.plate,
      view.pose === "muted"
        ? "Muted"
        : view.pose === "asleep"
          ? "The mob is resting"
          : options.harness
            ? "Round Ink"
            : "",
    );
    stateTag.host.hidden = !stateTag.plate.textContent;
    bubble.host.hidden = view.pose !== "inhale";
    write(
      raid.plate,
      view.raid ? `${view.raid.name} raided with ${String(view.raid.viewers)} viewers` : "",
    );
    raid.host.hidden = !view.raid;
    write(
      hype.plate,
      view.state.hype
        ? "Hype Train \u00b7 level " +
            String(view.state.hype.level) +
            (view.state.hype.shared ? " \u00b7 shared" : "")
        : "",
    );
    hype.host.hidden = !view.state.hype;
    if (!fitted) {
      if (line) fitPlate(caption.plate, zones.caption);
      fitPlate(counter.plate, zones.counter);
      fitPlate(question.plate, zones.question, 2);
      fitPlate(dissent.plate, zones.dissent, 2);
      fitted = true;
    } else {
      if (questionChanged) fitPlate(question.plate, zones.question, 2);
      if (dissentChanged) fitPlate(dissent.plate, zones.dissent, 2);
    }
    if (meterChanged || changedLayout)
      fitPlate(meter.plate, zones.meter, layout === "compact" ? 1 : 2);
    face.setPose(view.pose);
    face.setMood(view.state.mood);
    face.setHype(view.state.hype?.level ?? null);
    const mouth = lips.update({
      nowMs: now,
      dtMs: dt,
      pose: view.pose,
      channel: view.audioChannel,
      rms: view.rms,
      lowBand: options.lowBand?.() ?? 0,
    });
    root.dataset.mouthOpenness = mouth.openness.toFixed(3);
    root.dataset.mouthShape = mouth.shape;
    face.setMouth(mouth.openness, mouth.shape);
    const gaze = particleGaze(
      view.pose === "idle" && view.state.step === "listening" ? particles.newestPosition() : null,
      zones.face,
    );
    root.dataset.gazeX = gaze.x.toFixed(3);
    root.dataset.gazeY = gaze.y.toFixed(3);
    face.lookAt(gaze.x, gaze.y);
    face.update(now);
  }, options.clock);
  loop.setActive(true);
  return {
    setActive(value: boolean) {
      store.setActive(value);
      loop.setActive(value);
    },
    destroy() {
      alive = false;
      loop.destroy();
      face.destroy();
      particles.destroy();
      root.replaceChildren();
    },
  };
}
