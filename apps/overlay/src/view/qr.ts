import { renderSVG } from "uqr";

export const QR_OPTIONS = {
  ecc: "M",
  boostEcc: false,
  border: 4,
  blackColor: "#13211f",
  whiteColor: "#fbf3e0",
} as const;

export function channelUrl(login: string): string {
  if (!/^[a-z0-9_]{1,25}$/.test(login)) throw new Error("Invalid channel login");
  return `https://twitch.tv/${login}`;
}

export function channelQr(login: string, render: typeof renderSVG = renderSVG): string {
  return render(channelUrl(login), QR_OPTIONS);
}

export function createChannelQr(login: string): SVGSVGElement {
  // The encoder emits SVG; parsing it avoids HTML insertion for any text source.
  const xml = new DOMParser().parseFromString(channelQr(login), "image/svg+xml");
  const element = document.importNode(xml.documentElement, true);
  if (!(element instanceof SVGSVGElement)) throw new Error("QR rendering unavailable");
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "Channel QR code");
  return element;
}
