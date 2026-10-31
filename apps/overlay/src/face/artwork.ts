import type { MouthShape } from "./types.js";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
const path = (d: string, className: string) => svg("path", { d, class: className });

function createEye(x: number, y: number, side: "left" | "right") {
  const root = svg("g", { transform: `translate(${x} ${y})`, class: `ri-eye ri-${side}` });
  const open = svg("g");
  const mood = svg("g", { class: "ri-eye-mood" });
  const pupil = svg("g");
  pupil.append(
    path("M-19-8C-18-24-7-31 5-27C21-24 24-10 22 5C21 24 11 32-3 29C-17 27-22 12-19-8Z", "ri-ink"),
    svg("ellipse", { cx: 6, cy: -12, rx: 6, ry: 8, class: "ri-cream" }),
  );
  mood.append(
    path(
      "M-51-9C-51-33-31-45-6-44C26-46 51-34 52-7C55 20 34 40 5 41C-25 44-51 27-51-9Z",
      "ri-eye-white",
    ),
    pupil,
  );
  open.append(mood);
  const closed = path("M-43 0Q-4 29 43-2", "ri-line ri-closed-lid");
  const browPose = svg("g");
  const browAnchor = svg("g", { transform: "translate(0 -66)" });
  const brow = svg("g", { class: "ri-brow" });
  brow.append(path("M-36 1Q-3-12 34-2", "ri-line"));
  browPose.append(brow);
  browAnchor.append(browPose);
  root.append(open, closed, browAnchor);
  return { root, open, pupil, closed, browPose };
}

export function createArtwork(size: number) {
  const element = svg("svg", {
    viewBox: "0 0 512 512",
    width: size,
    height: size,
    role: "img",
    "aria-label": "Spokesmob face",
    class: "round-ink",
  });
  // Centering the drawing inside its motion group keeps every pose inside the viewBox.
  const body = svg("g");
  const drawing = svg("g", { transform: "translate(-256 -256)" });
  const silhouette =
    "M77 182C85 120 133 88 198 91C243 94 273 64 310 74C344 83 346 114 379 129C425 149 444 190 438 242C433 282 456 308 438 347C415 398 359 427 291 430C237 447 183 432 134 408C81 391 61 352 72 305C57 260 61 217 77 182Z";
  drawing.append(
    path(silhouette, "ri-shell"),
    path(
      "M91 190C99 139 140 110 199 112C250 115 280 86 306 94C332 102 332 130 366 146C408 163 421 198 416 243C411 285 434 307 417 340C391 387 345 407 285 410C234 426 187 411 144 391C100 376 83 344 93 306C78 262 78 228 91 190Z",
      "ri-skin",
    ),
    path("M91 196C101 149 139 122 184 124", "ri-lime-rim"),
    path("M257 111C278 103 296 98 308 107", "ri-crest"),
    path("M115 350C138 386 190 407 226 407", "ri-bottom-ink"),
  );
  const cheeks = svg("g", { class: "ri-cheeks" });
  cheeks.append(
    path("M107 292C109 278 139 276 154 284C172 295 156 312 135 311C117 312 104 304 107 292Z", ""),
    path("M357 286C371 277 397 282 400 294C403 308 384 316 365 310C351 306 347 295 357 286Z", ""),
  );
  drawing.append(cheeks);
  const eyes = [createEye(178, 239, "left"), createEye(326, 235, "right")];
  for (const eye of eyes) drawing.append(eye.root);
  drawing.append(
    path("M247 275Q253 280 260 275", "ri-line ri-nose"),
    path("M111 271L119 266M392 265L400 271", "ri-line ri-small-line"),
  );

  const mouth = svg("g");
  const mouths = new Map<MouthShape, SVGGElement>();
  const contours: Record<MouthShape, string> = {
    closed: "M-44-3C-17 11 17 11 44-5",
    mid: "M-45-9C-21-2 19-2 45-11C45 10 27 24 1 24C-25 24-43 13-45-9Z",
    open: "M-44-18C-22-28 24-28 44-18C52-1 40 43 6 46C-27 48-52 3-44-18Z",
    wide: "M-65-16C-35-23 35-23 65-16C62 15 39 40 0 40C-39 40-62 15-65-16Z",
    o: "M-26-8C-26-32-13-42 2-41C20-40 30-26 28-3C27 22 17 39 0 38C-18 38-28 18-26-8Z",
  };
  for (const [key, contour] of Object.entries(contours) as [MouthShape, string][]) {
    const group = svg("g");
    group.append(path(contour, key === "closed" ? "ri-line ri-lip" : "ri-mouth-cavity"));
    if (key === "mid" || key === "wide")
      group.append(path(key === "mid" ? "M-27-5Q0 1 28-6" : "M-42-12Q0-7 42-12", "ri-tooth"));
    if (key === "open" || key === "wide")
      group.append(
        path(
          key === "open" ? "M-17 30Q2 19 23 30Q6 49-17 30Z" : "M-28 27Q0 14 28 27Q0 43-28 27Z",
          "ri-tongue",
        ),
      );
    mouths.set(key, group);
    mouth.append(group);
  }
  const zip = svg("g", { class: "ri-zip" });
  zip.append(
    path(
      "M197 344Q251 350 310 343M205 335L205 354M224 337L224 355M244 338L244 356M264 338L264 356M284 336L284 354",
      "ri-line",
    ),
    path("M307 338L322 338L326 358Q316 366 306 358Z", "ri-zip-pull"),
  );
  drawing.append(mouth, zip);

  const accents = {
    thinking: path("M363 186Q382 188 385 204M374 175Q396 180 399 195", "ri-line ri-pose-line"),
    inhale: path("M101 315Q86 330 99 345M408 314Q424 329 410 344", "ri-breath"),
    aside: path("M105 324Q114 338 128 339M99 338Q107 350 120 352", "ri-aside-line"),
    settle: path("M352 355Q370 360 381 348M360 370Q382 374 393 359", "ri-breath"),
    reading: path("M145 294Q176 303 202 292M302 289Q330 300 356 287", "ri-line ri-reading-line"),
    sleep: path("M357 345Q376 337 383 349M366 363Q384 355 392 366", "ri-breath"),
  };
  drawing.append(...Object.values(accents));
  const gold = svg("g", { class: "ri-gold" });
  gold.append(
    path("M332 108C343 132 365 136 384 150C409 169 421 192 421 216", ""),
    path("M105 364L117 377M123 389L132 395", ""),
  );
  drawing.append(gold);
  body.append(drawing);
  element.append(body);
  return { element, body, eyes, mouth, mouths, zip, accents, gold };
}
