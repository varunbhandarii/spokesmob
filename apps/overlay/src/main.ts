import { type AudioPlayer, createAudioPlayer } from "./audio/player.js";
import { audioAllowed, decodeAudioFrame, parseControl } from "./protocol.js";
import { connectOverlay } from "./ws.js";

declare global {
  interface Window {
    obsstudio?: { getStatus?: (callback: (status: { active: boolean }) => void) => void };
  }
}

const status = document.querySelector<HTMLOutputElement>("#status");
const obs = window.obsstudio !== undefined;
const allowed = audioAllowed(obs, window.location.search);
let player: AudioPlayer | null = null;
let active = true;
let authorized = false;
let connectionState = "connecting";
let audioState = allowed ? "waiting for audio" : "preview, silent";
const showStatus = () => {
  if (status) status.textContent = `${connectionState} · ${audioState}`;
};

try {
  const connection = connectOverlay({
    location: window.location,
    audio: allowed,
    obs,
    active: () => active,
    state: (state) => {
      connectionState = state;
      showStatus();
    },
    disconnect: () => {
      authorized = false;
      player?.enabled(false);
      audioState = allowed ? "waiting for audio" : "preview, silent";
      showStatus();
    },
    message: async (value) => {
      if (value instanceof ArrayBuffer) {
        if (!authorized || !active) return;
        const chunk = decodeAudioFrame(value);
        if (chunk) player?.append(chunk);
        return;
      }
      const message = parseControl(value);
      if (!message) return;
      if (message.type === "hello") {
        authorized = allowed && message.audio;
        player?.stop();
        if (authorized && !player)
          player = await createAudioPlayer((event) => connection.send(event));
        player?.enabled(authorized && active);
        audioState = !allowed ? "preview, silent" : authorized ? "audio ready" : "preview, silent";
        showStatus();
        return;
      }
      if (message.type === "stop" || (authorized && active)) player?.control(message);
    },
  });
  window.addEventListener("obsSourceActiveChanged", (event) => {
    const detail = (event as CustomEvent<{ active?: boolean }>).detail;
    if (typeof detail?.active !== "boolean") return;
    active = detail.active;
    player?.enabled(authorized && active);
    connection.send({ type: "active", active });
    audioState =
      !allowed || !authorized ? "preview, silent" : active ? "audio ready" : "source inactive";
    showStatus();
  });
  window.obsstudio?.getStatus?.((state) => {
    active = state.active;
    player?.enabled(authorized && active);
    connection.send({ type: "active", active });
  });
  window.addEventListener("pagehide", () => {
    connection.close();
    void player?.close();
  });
} catch {
  connectionState = "unavailable";
  audioState = "preview, silent";
  showStatus();
}
