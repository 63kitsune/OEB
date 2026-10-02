import { calculateSebConfigHash } from "./config-key.js";

const SETTINGS_KEY = "sebInspectorSettings";

const elements = {
  statusPill: document.querySelector("#statusPill"),
  message: document.querySelector("#message"),
  metadata: document.querySelector("#metadata"),
  filename: document.querySelector("#filename"),
  mode: document.querySelector("#mode"),
  sourceUrl: document.querySelector("#sourceUrl"),
  passwordForm: document.querySelector("#passwordForm"),
  password: document.querySelector("#password"),
  headerDemoSection: document.querySelector("#headerDemoSection"),
  headerDemoPill: document.querySelector("#headerDemoPill"),
  headerDemoMessage: document.querySelector("#headerDemoMessage"),
  headerDemoButton: document.querySelector("#headerDemoButton"),
  xmlSection: document.querySelector("#xmlSection"),
  xml: document.querySelector("#xml"),
  fileInput: document.querySelector("#fileInput"),
  showStartupAnimation: document.querySelector("#showStartupAnimation"),
  taskbarMode: document.querySelector("#taskbarMode"),
  taskbarScale: document.querySelector("#taskbarScale"),
  taskbarScaleStatus: document.querySelector("#taskbarScaleStatus"),
  copyButton: document.querySelector("#copyButton"),
  saveButton: document.querySelector("#saveButton"),
  unloadButton: document.querySelector("#unloadButton")
};

let currentState = {};
let displaySaveQueue = Promise.resolve();

elements.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = elements.password.value;
  elements.password.value = "";
  elements.password.disabled = true;

  await browser.runtime.sendMessage({ type: "SEB_UNLOCK", password });
  elements.password.disabled = false;
  await refresh();
  elements.password.focus();
});

elements.fileInput.addEventListener("change", async () => {
  const file = elements.fileInput.files?.[0];
  if (!file) return;
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  await browser.runtime.sendMessage({
    type: "SEB_PROCESS_BYTES",
    bytes,
    filename: file.name,
    source: "selected file"
  });
  elements.fileInput.value = "";
  await refresh();
});

elements.headerDemoButton.addEventListener("click", async () => {
  elements.headerDemoButton.disabled = true;
  try {
    if (currentState.headerDemo?.enabled) {
      await browser.runtime.sendMessage({ type: "SEB_HEADER_DISABLE" });
    } else {
      const configHash = await calculateSebConfigHash(currentState.xml || "");
      const response = await browser.runtime.sendMessage({ type: "SEB_HEADER_ENABLE", configHash });
      if (!response.ok) throw new Error(response.error);
    }
  } catch (error) {
    elements.headerDemoMessage.textContent = error.message;
  } finally {
    elements.headerDemoButton.disabled = false;
    await refresh();
  }
});

elements.copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(currentState.xml || "");
  elements.copyButton.textContent = "Copied";
  setTimeout(() => { elements.copyButton.textContent = "Copy"; }, 1200);
});

elements.saveButton.addEventListener("click", () => {
  const blob = new Blob([currentState.xml || ""], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = (currentState.filename || "configuration.seb").replace(/\.seb$/i, "") + ".xml";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

elements.unloadButton.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "SEB_UNLOAD" });
  await refresh();
});

elements.showStartupAnimation.addEventListener("change", saveDisplaySettings);
elements.taskbarMode.addEventListener("change", saveDisplaySettings);
elements.taskbarScale.addEventListener("change", saveDisplaySettings);
elements.taskbarScale.addEventListener("input", () => {
  const value = Number(elements.taskbarScale.value);
  if (!Number.isFinite(value) || value < 50 || value > 300) {
    elements.taskbarScaleStatus.textContent = "Enter 50–300%.";
    return;
  }
  saveDisplaySettings();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (["session", "local"].includes(area) && changes.sebInspectorState) refresh();
  if (area === "local" && changes.sebInspectorSettings) refreshSettings();
});

async function refresh() {
  const response = await browser.runtime.sendMessage({ type: "SEB_GET_STATE" });
  render(response.state);
}

async function refreshSettings() {
  const response = await browser.runtime.sendMessage({ type: "SEB_GET_SETTINGS" });
  const settings = response?.settings || {};
  elements.showStartupAnimation.checked = settings.showStartupAnimation !== false;
  elements.taskbarMode.value = ["auto", "show", "hide"].includes(settings.taskbarMode) ? settings.taskbarMode : "auto";
  if (document.activeElement !== elements.taskbarScale) {
    elements.taskbarScale.value = validTaskbarScale(settings.taskbarScale) ? settings.taskbarScale : 100;
  }
}

async function saveDisplaySettings() {
  const scale = Number(elements.taskbarScale.value);
  if (!Number.isFinite(scale) || scale < 50 || scale > 300) return;
  const settings = {
    showStartupAnimation: elements.showStartupAnimation.checked,
    taskbarMode: elements.taskbarMode.value,
    taskbarScale: scale
  };
  elements.taskbarScaleStatus.textContent = "Saving…";
  displaySaveQueue = displaySaveQueue.catch(() => {}).then(async () => {
    const response = await browser.runtime.sendMessage({ type: "SEB_SET_SETTINGS", settings });
    if (!response?.ok) throw new Error(response?.error || "Could not save settings.");
    return response;
  });
  try {
    const response = await displaySaveQueue;
    // Persist the complete snapshot here as well. This keeps the value safe even if a stale
    // persistent MV2 background page responds without the newly added scale property.
    await browser.storage.local.set({ [SETTINGS_KEY]: settings });
    if (Number(elements.taskbarScale.value) === scale) {
      const confirmedScale = validTaskbarScale(response?.settings?.taskbarScale)
        ? Number(response.settings.taskbarScale)
        : scale;
      elements.taskbarScale.value = confirmedScale;
      elements.taskbarScaleStatus.textContent = `Saved at ${confirmedScale}%.`;
    }
  } catch (error) {
    elements.taskbarScaleStatus.textContent = `Not saved: ${error.message}`;
    displaySaveQueue = Promise.resolve();
  }
}

function validTaskbarScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale >= 50 && scale <= 300;
}

function render(state = {}) {
  currentState = state;
  const status = state.status || "idle";
  elements.statusPill.textContent = status.replace("-", " ");
  elements.statusPill.className = `pill ${status}`;
  elements.message.textContent = state.message || "Waiting for a SEB download or launch link.";

  const hasMetadata = Boolean(state.filename || state.mode || state.sourceUrl);
  elements.metadata.hidden = !hasMetadata;
  elements.filename.textContent = state.filename || "—";
  elements.mode.textContent = formatMode(state.mode);
  elements.sourceUrl.textContent = state.sourceUrl || "Local file";
  elements.sourceUrl.title = state.sourceUrl || "";

  elements.passwordForm.hidden = status !== "password-needed";
  elements.unloadButton.hidden = !["ready", "password-needed"].includes(status);
  elements.headerDemoSection.hidden = status !== "ready";
  elements.xmlSection.hidden = status !== "ready";
  elements.xml.textContent = status === "ready" ? formatXml(state.xml || "") : "";

  if (status === "password-needed") setTimeout(() => elements.password.focus(), 0);

  const demo = state.headerDemo || {};
  elements.headerDemoPill.textContent = demo.enabled ? `Enabled · ${demo.attachedTabs} tab${demo.attachedTabs === 1 ? "" : "s"}` : "Disabled";
  elements.headerDemoPill.className = `pill ${demo.enabled ? "ready" : "idle"}`;
  elements.headerDemoButton.textContent = demo.enabled ? "Disable SEB headers" : "Enable SEB headers";
  elements.headerDemoMessage.textContent = demo.error
    ? demo.error
    : "Applies the SEB User-Agent and calculated ConfigKeyHash to HTTP and HTTPS requests on all domains.";
}

function formatMode(mode) {
  const labels = {
    xml: "Plain XML",
    plnd: "Plain SEB data",
    pswd: "Password encrypted",
    pwcc: "Configuring-client password"
  };
  return labels[mode] || mode || "—";
}

function formatXml(xml) {
  const compact = xml.replace(/>\s*</g, "><").trim();
  let depth = 0;
  const lines = compact.replace(/</g, "\n<").trim().split("\n");
  return lines.map((line) => {
    if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
    const output = `${"  ".repeat(depth)}${line}`;
    if (/^<(?!\?|!|\/)(?!.*<\/)[^>]+>$/.test(line) && !/\/>$/.test(line)) depth += 1;
    return output;
  }).join("\n");
}

Promise.all([refresh(), refreshSettings()]);
