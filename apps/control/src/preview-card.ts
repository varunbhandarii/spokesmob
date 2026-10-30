import type { ControlModel } from "./model.js";
import { previewView } from "./preview.js";

export interface PreviewClock {
  now(): number;
  request(callback: () => void): number;
  cancel(id: number): void;
}
const browserClock: PreviewClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};
export function createPreviewCard(root: HTMLElement, veto: () => void, clock = browserClock) {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
    const node = document.createElement(tag);
    node.className = className;
    root.append(node);
    return node;
  };
  const title = make("h3", "preview-title");
  title.setAttribute("aria-live", "polite");
  const quiet = make("span", "preview-quiet");
  quiet.textContent = "Captions only";
  const line = make("p", "preview-line");
  const dissent = make("p", "preview-dissent");
  const summary = make("p", "preview-summary");
  const countdown = make("output", "preview-countdown");
  const track = make("div", "preview-track");
  const fill = document.createElement("div");
  fill.className = "preview-fill";
  track.append(fill);
  const button = make("button", "preview-veto");
  button.type = "button";
  button.textContent = "Veto this line";
  button.addEventListener("click", veto);
  let model: ControlModel | null = null;
  let connected = false;
  let frame: number | null = null;
  let destroyed = false;
  const write = (node: HTMLElement, text: string) => {
    if (node.textContent !== text) node.textContent = text;
  };
  const draw = () => {
    frame = null;
    if (destroyed || !model) return;
    const view = previewView(model.preview, model.state, connected, clock.now());
    root.hidden = view.kind === "hidden";
    root.dataset.kind = view.kind;
    write(title, view.kind === "vetoed" ? "Vetoed" : "Next line");
    write(line, view.text);
    write(dissent, view.dissent ?? "");
    write(summary, view.summary);
    write(countdown, `${(Math.ceil(view.remainingMs / 100) / 10).toFixed(1)} s preview`);
    fill.style.transform = `scaleX(${String(view.progress)})`;
    quiet.hidden = !view.quiet;
    line.hidden = view.kind !== "preview";
    dissent.hidden = view.kind !== "preview" || !view.dissent;
    summary.hidden = countdown.hidden = track.hidden = button.hidden = view.kind !== "preview";
    button.disabled = !connected || model.state?.step !== "preview";
    if (view.kind !== "hidden") frame = clock.request(draw);
  };
  return {
    update(value: ControlModel, isConnected: boolean) {
      model = value;
      connected = isConnected;
      if (frame !== null) clock.cancel(frame);
      draw();
    },
    destroy() {
      destroyed = true;
      if (frame !== null) clock.cancel(frame);
      button.removeEventListener("click", veto);
      root.replaceChildren();
    },
  };
}
