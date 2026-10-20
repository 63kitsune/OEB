import { calculateSebConfigHash } from "./config-key.js";
import { importSelectedFile } from "./file-import.js";

import { bekSettingsForVersion } from "./bek-selection.js";

const importPage = new URL(location.href).searchParams;
const standaloneImport = importPage.get("file") === "1";
const importTarget = Number(importPage.get("target"));
document.documentElement.classList.toggle("standalone", standaloneImport);
document.querySelector("#filePickerHint").hidden = !standaloneImport;

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
  closeTabOnQuit: document.querySelector("#closeTabOnQuit"),
  quitSettingStatus: document.querySelector("#quitSettingStatus"),
  checkDownloadsForSeb: document.querySelector("#checkDownloadsForSeb"),
  downloadCheckStatus: document.querySelector("#downloadCheckStatus"),
  showStartupAnimation: document.querySelector("#showStartupAnimation"),
  taskbarMode: document.querySelector("#taskbarMode"),
  taskbarScale: document.querySelector("#taskbarScale"),
  taskbarScaleStatus: document.querySelector("#taskbarScaleStatus"),
  copyButton: document.querySelector("#copyButton"),
  saveButton: document.querySelector("#saveButton"),
  unloadButton: document.querySelector("#unloadButton")
};

const bekVersion = document.querySelector("#bekVersionSelect");
const bekStatus = document.querySelector("#bekSettingsStatus");
let savedBekVersion = "3.10.2.920";

bekVersion.addEventListener("change", async () => {
  const value = bekVersion.value;
  bekVersion.disabled = true;
  bekStatus.textContent = "Saving…";
  try {
    const response = await browser.runtime.sendMessage({
      type: "SEB_SET_BEK_SETTINGS", settings: bekSettingsForVersion(value)
    });
    if (!response?.ok) throw new Error(response?.error || "Could not save the BEK version.");
    savedBekVersion = value;
    bekStatus.textContent = value === "off" ? "Saved. BEK is off."
      : "Saved. BEK is calculated automatically for each exam file.";
    await refresh();
  } catch (error) {
    bekVersion.value = savedBekVersion;
    bekStatus.textContent = `Not saved: ${error.message}`;
  } finally {
    bekVersion.disabled = false;
  }
});

async function refreshBekSettings() {
  const response = await browser.runtime.sendMessage({ type: "SEB_GET_BEK_SETTINGS" });
  if (!response?.ok) throw new Error(response?.error || "Could not load the BEK version.");
  const settings = response.settings;
  if (settings.enabled && settings.mode === "provided") {
    // The 2.4 selector replaces the old manual-key workflow with automatic calculation.
    const migrated = await browser.runtime.sendMessage({
      type: "SEB_SET_BEK_SETTINGS", settings: bekSettingsForVersion("3.10.2.920")
    });
    if (!migrated?.ok) throw new Error(migrated?.error || "Could not update the saved BEK settings.");
    Object.assign(settings, migrated.settings);
  }
  savedBekVersion = settings.enabled ? settings.buildVersion : "off";
  bekVersion.value = savedBekVersion;
  if (!bekVersion.value) {
    bekVersion.value = "off";
    bekStatus.textContent = "This saved version is unsupported. Choose SEB 3.10.2.920 to calculate BEK automatically.";
  } else {
    bekStatus.textContent = settings.enabled ? "Calculated automatically for each exam file." : "BEK is off.";
  }
}

let currentState = {};
let displaySaveQueue = Promise.resolve();

elements.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = elements.password.value;
  elements.password.value = "";
  elements.password.disabled = true;

  try {
    const response = await browser.runtime.sendMessage({ type: "SEB_UNLOCK", password });
    if (!response?.ok && response?.error) throw new Error(response.error);
    await refresh();
  } catch (error) {
    elements.message.textContent = `Could not open this file: ${error.message}`;
  } finally {
    elements.password.disabled = false;
    if (!elements.passwordForm.hidden) elements.password.focus();
  }
});

document.querySelector("#openFileButton").hidden = standaloneImport;
document.querySelector("#filePickerLabel").hidden = !standaloneImport;
document.querySelector("#openFileButton").addEventListener("click", async () => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = new URL(browser.runtime.getURL("popup.html"));
    url.searchParams.set("file", "1");
    if (Number.isInteger(tab?.id)) url.searchParams.set("target", String(tab.id));
    await browser.tabs.create({ url: url.href });
    window.close();
  } catch (error) {
    elements.message.textContent = `Could not open the file picker: ${error.message}`;
  }
});

elements.fileInput.addEventListener("change", async () => {
  const file = elements.fileInput.files?.[0];
  if (!file) return;
  elements.fileInput.disabled = true;
  elements.message.textContent = `Opening ${file.name}…`;
  try {
    await importSelectedFile(file, request => browser.runtime.sendMessage(request),
      standaloneImport && Number.isInteger(importTarget) && importTarget > 0 ? importTarget : undefined);
    await refresh();
  } catch (error) {
    elements.statusPill.textContent = "Error";
    elements.statusPill.className = "pill error";
    elements.message.textContent = `Could not open ${file.name}: ${error.message}`;
  } finally {
    elements.fileInput.disabled = false;
    elements.fileInput.value = "";
  }
});

elements.headerDemoButton.addEventListener("click", async () => {
  elements.headerDemoButton.disabled = true;
  let headerError;
  try {
    if (currentState.headerDemo?.enabled) {
      await browser.runtime.sendMessage({ type: "SEB_HEADER_DISABLE" });
    } else {
      const configHash = await calculateSebConfigHash(currentState.xml || "");
      const response = await browser.runtime.sendMessage({ type: "SEB_HEADER_ENABLE", configHash });
      if (!response.ok) throw new Error(response.error);
    }
  } catch (error) {
    headerError = error.message;
  } finally {
    elements.headerDemoButton.disabled = false;
    await refresh();
    if (headerError) elements.headerDemoMessage.textContent = headerError;
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

elements.closeTabOnQuit.addEventListener("change", saveDisplaySettings);
elements.checkDownloadsForSeb.addEventListener("change", saveDisplaySettings);
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
  if (!response?.ok) throw new Error(response?.error || "Could not read the exam status.");
  render(response.state);
}

async function refreshSettings() {
  const response = await browser.runtime.sendMessage({ type: "SEB_GET_SETTINGS" });
  if (!response?.ok) throw new Error(response?.error || "Could not read your settings.");
  const settings = response.settings;
  elements.closeTabOnQuit.checked = settings.closeTabOnQuit !== false;
  elements.checkDownloadsForSeb.checked = settings.checkDownloadsForSeb !== false;
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
    checkDownloadsForSeb: elements.checkDownloadsForSeb.checked,
    closeTabOnQuit: elements.closeTabOnQuit.checked,
    showStartupAnimation: elements.showStartupAnimation.checked,
    taskbarMode: elements.taskbarMode.value,
    taskbarScale: scale
  };
  const statusElement = document.activeElement === elements.checkDownloadsForSeb
    ? elements.downloadCheckStatus : document.activeElement === elements.closeTabOnQuit
      ? elements.quitSettingStatus : elements.taskbarScaleStatus;
  statusElement.textContent = "Saving…";
  displaySaveQueue = displaySaveQueue.catch(() => {}).then(async () => {
    const response = await browser.runtime.sendMessage({ type: "SEB_SET_SETTINGS", settings });
    if (!response?.ok) throw new Error(response?.error || "Could not save settings.");
    return response;
  });
  try {
    const response = await displaySaveQueue;
    // The background owns persistence; do not overwrite a newer snapshot from the popup.
    if (Number(elements.taskbarScale.value) === scale) {
      elements.taskbarScale.value = response.settings.taskbarScale;
    }
    statusElement.textContent = "Saved.";
  } catch (error) {
    statusElement.textContent = `Not saved: ${error.message}`;
    await refreshSettings();
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
  elements.statusPill.textContent = ({ idle: "Ready", ready: "Exam loaded", downloading: "Opening…", "password-needed": "Password needed", error: "Needs attention" })[status] || status;
  elements.statusPill.className = `pill ${status}`;
  elements.message.textContent = (status === "idle" ? "Ready when you are." : state.message) || "Ready when you are.";

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
  elements.headerDemoButton.textContent = demo.enabled ? "Disconnect" : "Connect";
  elements.headerDemoMessage.textContent = demo.error
    ? demo.error
    : demo.enabled
      ? `Exam origin: ${demo.examOrigin}. Build: ${demo.buildVersion}. CK enabled. BEK: ${demo.bekMode === "provided" ? "configured key" : demo.bekMode === "automatic" ? "calculated automatically" : demo.bekMode === "missing-key" ? "missing — paste your quiz's allowed BEK" : "disabled"}. Requests with BEK: ${demo.requestsWithBek || 0}.`
      : "Sends CK and BEK responses to the configured exam origin.";
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

Promise.all([refresh(), refreshSettings(), refreshBekSettings()]).catch(error => {
  elements.statusPill.textContent = "Needs attention";
  elements.statusPill.className = "pill error";
  elements.message.textContent = `Could not load settings: ${error.message}. Reload the extension and try again.`;
});
