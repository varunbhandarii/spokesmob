import { type AudioPlayer, createAudioPlayer } from "./audio/player.js";
import { audioAllowed, decodeAudioFrame, parseControl } from "./protocol.js";
import { sourceActive, sourceAudioStatus } from "./source-active.js";
import { connectOverlay } from "./ws.js";

const status = document.querySelector<HTMLOutputElement>("#status");
const obs = "obsstudio" in window && window.obsstudio !== undefined;
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
        audioState = sourceAudioStatus(allowed, authorized, active);
        showStatus();
        return;
      }
      if (message.type === "stop" || (authorized && active)) player?.control(message);
    },
  });
  window.addEventListener("obsSourceActiveChanged", (event) => {
    const next = sourceActive(active, event);
    if (next === active) return;
    active = next;
    player?.enabled(authorized && active);
    connection.send({ type: "active", active });
    audioState = sourceAudioStatus(allowed, authorized, active);
    showStatus();
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
