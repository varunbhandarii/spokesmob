import { formatVoiceCount } from "../../../../packages/core/src/voice-count.js";
import { createFace } from "../face/index.js";
import { speechTail, voteRing, waveform } from "./decorations.js";
import { LAYOUTS, type Zone } from "./layout.js";
import { createLipSync, particleGaze } from "./lip-sync.js";
import { createFrameLoop, type FrameClock } from "./loop.js";
import { createParticleCanvas } from "./particle-canvas.js";
import { createChannelQr } from "./qr.js";
import type { ViewStore } from "./store.js";
import { captionWords, countUp, dissentCopy, needsMeanwhile } from "./text.js";
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
  const style = getComputedStyle(node);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  // Font metrics and line wrapping are measured only when text/layout changes.
  while (
    size > 12 &&
    (Math.max(node.scrollWidth, node.offsetWidth) > zone.width + 1 ||
      Math.max(node.scrollHeight, node.offsetHeight) > zone.height + 1 ||
      node.scrollHeight > size * 1.2 * lines + padding + 1)
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
  caption.host.classList.add("caption-slot");
  const lead = make("caption-lead", caption.plate);
  const wordsHost = make("caption-words", caption.plate);
  const compactAside = document.createElement("span");
  compactAside.className = "compact-dissent";
  caption.plate.append(speechTail());
  const meter = slot("agreement");
  const meterPct = make("agreement-pct", meter.plate);
  const meterFacts = make("agreement-facts", meter.plate);
  const meterDots = make("agreement-dots", meter.plate);
  meterDots.setAttribute("aria-hidden", "true");
  const dots = Array.from({ length: 10 }, () => {
    const dot = document.createElement("i");
    meterDots.append(dot);
    return dot;
  });
  const dissent = slot("dissent");
  const dissentPct = make("dissent-pct", dissent.plate);
  const dissentText = make("dissent-text", dissent.plate);
  const counter = slot("counter");
  const counterNumber = make("counter-number", counter.plate);
  const counterLabel = make("counter-label", counter.plate);
  const question = slot("question");
  question.host.classList.add("question-slot");
  for (let i = 0; i < 2; i++) make("tape", question.plate).setAttribute("aria-hidden", "true");
  const questionTab = make("question-tab", question.plate);
  write(questionTab, "CHAT, WEIGH IN");
  const questionText = make("question-copy", question.plate);
  const badge = slot("ai-badge");
  const join = slot("join-hint");
  const bubble = slot("preview-bubble");
  const raid = slot("raid-banner");
  const hype = slot("hype-chip");
  const vote = slot("vote-plate");
  const voteHead = make("vote-head", vote.plate);
  const voteTitle = make("vote-title", voteHead);
  const timer = make("vote-timer", voteHead);
  const ring = voteRing();
  timer.append(ring.element);
  const voteCounts = make("vote-counts", timer);
  const voteRows = [0, 1].map((i) => {
    const row = make("vote-row", vote.plate);
    row.dataset.choice = String(i + 1);
    const label = make("vote-label", row);
    const key = make("vote-key", label);
    write(key, `${i + 1} `);
    const text = make("vote-choice", label);
    const track = make("vote-track", row);
    const bar = make("vote-bar", track);
    const stats = make("vote-stats", row);
    const count = make("vote-count", stats);
    const share = make("vote-share", stats);
    return { text, bar, count, share };
  });
  write(
    make("vote-footer", vote.plate),
    "Type 1 or 2 in chat \u00b7 one vote each, last one counts",
  );
  const clipped = slot("clipped-badge");
  write(clipped.plate, "CLIPPED!");
  const demo = slot("demo-tag");
  write(demo.plate, "Demo · simulated voice");
  const stateTag = slot("state-tag");
  const qr = make("channel-qr");
  write(make("qr-title", qr), "Join the mob");
  const qrImage = make("qr-image", qr);
  const qrLabel = make("qr-label", qr);
  const face = createFace({ seed: options.seed ?? 1729, size: 512 });
  faceHost.append(face.element);
  const lips = createLipSync();
  const particles = createParticleCanvas(root, options.seed ?? 1729);
  badge.plate.append(waveform());
  write(make("badge-label", badge.plate), "AI voice");
  bubble.plate.setAttribute("aria-label", "Thinking");
  for (let i = 0; i < 3; i++) make("dot", bubble.plate);
  let qrChannel = "";
  let layout = "";
  let captionKey = "";
  let voteKey = "";
  let wordNodes: HTMLSpanElement[] = [];
  let fitted = false;
  let alive = true;
  let renderedFrames = 0;
  void document.fonts.ready.then(() => {
    if (alive) {
      fitted = false;
      voteKey = "";
      particles.invalidate();
    }
  });
  const loop = createFrameLoop((now, dt) => {
    options.beforeDraw?.(now);
    if (options.sample) store.sample(options.sample());
    const view = store.view();
    const zones = LAYOUTS[view.layout];
    const voteZone = zones.vote;
    vote.host.hidden = !view.vote;
    if (view.vote) {
      write(voteTitle, "CHAT VOTE");
      write(voteCounts, String(Math.ceil(view.vote.remainingMs / 1000)));
      timer.setAttribute(
        "aria-label",
        `${Math.ceil(view.vote.remainingMs / 1000)} seconds remaining`,
      );
      ring.progress.setAttribute(
        "stroke-dashoffset",
        String(48 * Math.PI * (1 - Math.min(1, view.vote.remainingMs / 30000))),
      );
      const total = Math.max(1, view.vote.counts[0] + view.vote.counts[1]);
      for (let i = 0; i < 2; i++) {
        const row = voteRows[i];
        if (row) {
          write(row.text, view.vote.choices[i] ?? "");
          write(row.count, String(view.vote.counts[i] ?? 0));
          write(row.share, `${Math.round((100 * (view.vote.counts[i] ?? 0)) / total)}%`);
          row.bar.style.transform = `scaleX(${(view.vote.counts[i] ?? 0) / total})`;
        }
      }
    }
    clipped.host.hidden = !view.clipped;
    demo.host.hidden = !view.simulatedVoice;
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
    root.dataset.voting = String(!!view.vote);
    const changedLayout = layout !== view.layout;
    if (changedLayout) {
      layout = view.layout;
      fitted = false;
      place(faceHost, zones.face);
      place(vote.host, voteZone);

      place(demo.host, { x: zones.margin, y: zones.margin, width: 400, height: 42, fontSize: 22 });
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
      const bubbleZone = {
        x: zones.face.x + zones.face.width - 18,
        y: zones.face.y + (view.layout === "stage" ? 130 : 40),
        width: 124,
        height: 78,
        fontSize: 48,
      };
      place(bubble.host, bubbleZone);
      place(clipped.host, {
        ...zones.badge,
        x: view.layout === "stage" ? 1300 : zones.face.x,
        y: view.layout === "stage" ? 440 : view.layout === "compact" ? 770 : 620,
        width: 190,
        height: 80,
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
    const nextVoteKey = view.vote
      ? JSON.stringify([layout, view.vote.choices, view.vote.counts])
      : "";
    if (nextVoteKey !== voteKey) {
      voteKey = nextVoteKey;
      if (view.vote) fitPlate(vote.plate, voteZone, 8);
    }
    if (qrChannel !== view.channel) {
      qrChannel = view.channel;
      qrImage.replaceChildren(createChannelQr(view.channel));
      qr.dataset.url = `https://twitch.tv/${view.channel}`;
      write(qrLabel, `twitch.tv/${view.channel}`);
    }
    const visible = view.caption;
    const line = visible?.line;
    const aside = visible?.dissent
      ? dissentCopy(line?.dissentPct ?? null, line?.dissent ?? null)
      : "";
    const meanwhile = needsMeanwhile(line, view.state.question);
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
    for (let i = 0; i < wordNodes.length; i++) {
      wordNodes[i]?.classList.toggle("is-current", i === visible?.highlighted);
      wordNodes[i]?.classList.toggle(
        "is-upcoming",
        !!visible && visible.highlighted >= 0 && i > visible.highlighted,
      );
    }
    const pct = countUp(line?.pct ?? 0, visible?.ageMs ?? 0);
    const voices = countUp(line?.voices ?? 0, visible?.ageMs ?? 0);
    const pctChanged = write(meterPct, `${String(pct)}% `);
    const factsChanged = write(meterFacts, `of ${formatVoiceCount(voices)}`);
    const meterChanged = pctChanged || factsChanged;
    for (let i = 0; i < dots.length; i++) {
      const dot = dots[i];
      if (dot) dot.dataset.filled = String(i < Math.round(pct / 10));
    }
    meter.host.hidden = !line || line.voices === 0 || line.showAgreement === false;
    counter.host.hidden = !meter.host.hidden;
    meter.plate.dataset.pct = String(line?.pct ?? 0);
    const dissentPctChanged = write(dissentPct, `${String(line?.dissentPct ?? 0)}% `);
    const dissentTextChanged = write(dissentText, aside ? `\u00b7 ${line?.dissent ?? ""}` : "");
    const dissentChanged = dissentPctChanged || dissentTextChanged;
    dissent.host.hidden = !aside || layout === "compact";
    write(counterNumber, String(view.voices));
    write(counterLabel, "chatting");
    const questionChanged = write(questionText, view.state.question ?? "");
    question.host.hidden = !view.state.question;
    write(join.plate, "Type in chat to join");
    join.host.hidden =
      view.state.step !== "listening" ||
      view.pose !== "idle" ||
      (layout !== "stage" && view.voices >= 2);
    write(
      stateTag.plate,
      view.pose === "muted" ? "Muted" : view.pose === "asleep" ? "The mob is resting" : "",
    );
    stateTag.host.hidden = !stateTag.plate.textContent;
    bubble.host.hidden = view.pose !== "inhale" && view.pose !== "thinking";
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
    const fitChanged = !fitted;
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
    if (meterChanged || changedLayout || fitChanged) {
      fitPlate(meter.plate, zones.meter, 2);
      if (line)
        place(meter.host, {
          ...zones.meter,
          x:
            zones.caption.x +
            caption.plate.offsetLeft +
            caption.plate.offsetWidth -
            zones.meter.width +
            16,
          y: zones.caption.y + caption.plate.offsetTop - zones.meter.height * 0.65,
        });
    }
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
