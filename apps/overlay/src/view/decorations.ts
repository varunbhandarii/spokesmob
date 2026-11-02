const namespace = "http://www.w3.org/2000/svg";
const svg = (className: string, viewBox: string) => {
  const node = document.createElementNS(namespace, "svg");
  node.setAttribute("class", className);
  node.setAttribute("viewBox", viewBox);
  node.setAttribute("aria-hidden", "true");
  return node;
};

export function speechTail() {
  const node = svg("bubble-tail", "0 0 72 64");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", "M70 8 Q32 22 4 55 Q35 42 70 43");
  node.append(path);
  return node;
}

export function waveform() {
  const node = svg("waveform", "0 0 24 20");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", "M3 7v6m6-10v14m6-11v8m6-10v12");
  node.append(path);
  return node;
}

export function voteRing() {
  const node = svg("vote-ring", "0 0 60 60");
  const rings = ["ring-track", "ring-progress"].map((className) => {
    const ring = document.createElementNS(namespace, "circle");
    for (const [name, value] of Object.entries({ cx: "30", cy: "30", r: "24", class: className }))
      ring.setAttribute(name, value);
    node.append(ring);
    return ring;
  });
  const progress = rings[1];
  if (!progress) throw new Error("Vote ring unavailable");
  progress.setAttribute("stroke-dasharray", String(48 * Math.PI));
  return { element: node, progress };
}
