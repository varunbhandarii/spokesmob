import { type AudioPlayer, createAudioPlayer } from "./audio/player.js";
import { audioAllowed, decodeAudioFrame, parseControl } from "./protocol.js";
import { needsSoundGesture } from "./sound-gesture.js";
import { overlayStatusVisible, sourceActive, sourceAudioStatus } from "./source-active.js";
import { createRenderer } from "./view/render.js";
import { createViewStore } from "./view/store.js";
import { connectOverlay } from "./ws.js";

const status = document.querySelector<HTMLOutputElement>("#status");
const obs = "obsstudio" in window && window.obsstudio !== undefined;
const allowed = audioAllowed(obs, window.location.search);
let player: AudioPlayer | null = null;
const sound = document.createElement("button");
sound.className = "sound-enable plate";
sound.textContent = "Click to enable sound";
sound.hidden = true;
document.body.append(sound);
const updateSound = () => {
  sound.hidden = !needsSoundGesture(obs, authorized, player?.state() ?? "closed");
  audioState = sourceAudioStatus(allowed, authorized, active);
  if (allowed && authorized && active && player?.state() !== "running")
    audioState = "audio blocked";
  showStatus();
};
sound.addEventListener("click", () => {
  void player?.resume().then(updateSound).catch(updateSound);
});
let active = true;
let authorized = false;
let connectionState = "connecting";
let audioState = allowed ? "waiting for audio" : "preview, silent";
const store = createViewStore(new URLSearchParams(window.location.search).get("layout"));
const root = document.querySelector<HTMLElement>("#overlay");
if (!root) throw new Error("Overlay view unavailable");
const renderer = createRenderer({
  root,
  store,
  lowBand: () => {
    const channel = store.view().audioChannel;
    return player && channel ? player.lowBand(channel) : 0;
  },
  sample: () => {
    const channel = store.view().audioChannel;
    return player && channel ? player.rms(channel) : 0;
  },
});
const showStatus = () => {
  if (status) {
    status.textContent = `${connectionState} \u00b7 ${audioState}`;
    status.hidden = !overlayStatusVisible(connectionState, audioState);
  }
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
      updateSound();
      store.disconnected();
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
      store.receive(message);
      if (message.type === "hello") {
        authorized = allowed && message.audio;
        player?.stop();
        if (authorized && !player)
          player = await createAudioPlayer((event) => {
            store.playback(event);
            connection.send(event);
          }, updateSound);
        player?.enabled(authorized && active);
        audioState = sourceAudioStatus(allowed, authorized, active);
        showStatus();
        updateSound();
        return;
      }
      if (
        (message.type === "prepare" || message.type === "play" || message.type === "stop") &&
        (message.type === "stop" || (authorized && active))
      )
        player?.control(message);
    },
  });
  window.addEventListener("obsSourceActiveChanged", (event) => {
    const next = sourceActive(active, event);
    if (next === active) return;
    active = next;
    renderer.setActive(active);
    player?.enabled(authorized && active);
    connection.send({ type: "active", active });
    updateSound();
  });
  window.addEventListener("pagehide", () => {
    connection.close();
    renderer.destroy();
    void player?.close();
  });
} catch {
  connectionState = "unavailable";
  audioState = "preview, silent";
  showStatus();
}
