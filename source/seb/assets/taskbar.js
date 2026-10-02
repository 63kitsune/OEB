const parameters = new URLSearchParams(location.search);
const enabled = name => parameters.get(name) === "1";
const height = Math.max(20, Math.min(240, Number(parameters.get("height")) || 40));
document.documentElement.style.setProperty("--taskbar-height", `${height}px`);
document.documentElement.style.setProperty("--taskbar-scale", String(height / 40));

const controls = {
  reload: document.getElementById("reloadControl"),
  audio: document.getElementById("audioControl"),
  battery: document.getElementById("batteryControl"),
  batteryCharge: document.getElementById("batteryCharge"),
  network: document.getElementById("networkControl"),
  keyboard: document.getElementById("keyboardControl"),
  clock: document.getElementById("clockControl"),
  shutdown: document.getElementById("shutdownControl")
};

controls.reload.hidden = !enabled("reload");
controls.audio.hidden = !enabled("audio");
controls.network.hidden = !enabled("network");
controls.keyboard.hidden = !enabled("keyboard");
controls.clock.hidden = !enabled("clock");
controls.shutdown.hidden = !enabled("quit");

const language = (navigator.language || "en").split("-")[0];
controls.keyboard.textContent = ({de: "DE", fr: "FR", it: "IT", es: "ES", nl: "NL", pt: "PT", pl: "PL"})[language] || "ENG";

function updateTime() {
  const now = new Date();
  document.getElementById("time").textContent = now.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  document.getElementById("date").textContent = now.toLocaleDateString();
}
updateTime();
setInterval(updateTime, 1000);

function updateNetwork() {
  controls.network.style.opacity = navigator.onLine ? "1" : "0.45";
  controls.network.title = navigator.onLine ? "Network connected" : "Network disconnected";
}
updateNetwork();
addEventListener("online", updateNetwork);
addEventListener("offline", updateNetwork);

if (navigator.getBattery) {
  navigator.getBattery().then(battery => {
    controls.battery.hidden = false;
    const update = () => {
      const level = Math.max(0, Math.min(1, battery.level));
      controls.batteryCharge.setAttribute("width", String(29 * level));
      controls.batteryCharge.setAttribute("fill", level < 0.1 ? "#d32f2f" : level < 0.25 ? "#ff9800" : "#1f9f44");
      controls.battery.title = `${Math.round(level * 100)}%${battery.charging ? " charging" : " remaining"}`;
    };
    battery.addEventListener("levelchange", update);
    battery.addEventListener("chargingchange", update);
    update();
  }).catch(() => {});
}

controls.reload.addEventListener("click", () => {
  parent.postMessage({type: "SEB_RELOAD_REQUEST", warning: enabled("reloadWarning")}, "*");
});
controls.audio.addEventListener("click", () => parent.postMessage({type: "SEB_AUDIO_TOGGLE"}, "*"));
controls.shutdown.addEventListener("click", () => parent.postMessage({type: "SEB_QUIT_REQUEST"}, "*"));

addEventListener("message", event => {
  if (event.source !== parent || event.data?.type !== "SEB_AUDIO_STATE") return;
  document.getElementById("audioWaves").style.display = event.data.muted ? "none" : "block";
  controls.audio.title = event.data.muted ? "Unmute audio" : "Mute audio";
});
