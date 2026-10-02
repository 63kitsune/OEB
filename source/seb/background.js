import { decodeEmbeddedSebUrl, inspectSebFile, SebParseError } from "./parser.js";
import {
  disableHeaderInjection,
  enableHeaderInjection,
  getHeaderStatus,
  reloadActiveHeaderTab
} from "./headers.js";
import {
  calculateSebConfigHash,
  getSebPresentationSettings,
  getSebQuitSettings,
  getSebStartUrl,
  verifySebQuitPassword
} from "./config-key.js";
import { answerTab, installAssistantCommands } from "../assistant/background.js";

const STATE_KEY = "sebInspectorState";
const PENDING_KEY = "sebInspectorPending";
const SETTINGS_KEY = "sebInspectorSettings";
const DEFAULT_SETTINGS = Object.freeze({ showStartupAnimation: true, taskbarMode: "auto", taskbarScale: 100 });
const duplicateRequests = new Map();
const pageTransitions = new Map();
const presentationTabs = new Set();

installAssistantCommands();

browser.tabs.onRemoved.addListener((tabId) => {
  pageTransitions.delete(tabId);
  presentationTabs.delete(tabId);
});

browser.runtime.onInstalled.addListener(async () => {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) await saveSettings(DEFAULT_SETTINGS);
  await saveState({ status: "idle", message: "Waiting for a SEB download or launch link." });
});

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

browser.downloads.onCreated.addListener((item) => {
  const url = item.finalUrl || item.url;
  if (isSebUrl(url) || item.filename?.toLowerCase().endsWith(".seb") || isSebMime(item.mime)) {
    processUrl(url, {
      source: "browser download",
      autoLaunch: true,
      filename: fileNameFromPath(item.filename) || fileNameFromUrl(url)
    });
  }
});

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const headers = Object.fromEntries(
      (details.responseHeaders || []).map((header) => [header.name.toLowerCase(), header.value || ""])
    );
    const disposition = headers["content-disposition"] || "";
    const mime = (headers["content-type"] || "").split(";", 1)[0];
    const sebResponse = isSebUrl(details.url)
      || /filename\*?\s*=.*\.seb(?:["';]|$)/i.test(disposition)
      || isSebMime(mime);

    if (sebResponse) {
      processUrl(details.url, {
        source: "SEB response",
        tabId: details.tabId,
        autoLaunch: true,
        filename: fileNameFromDisposition(disposition) || fileNameFromUrl(details.url)
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

async function handleMessage(request, sender) {
  switch (request?.type) {
    case "OEB_AI_RUN":
      return answerTab(request.tabId);
    case "SEB_CAPTURE_URL":
      await processUrl(request.url, {
        source: request.source || "page link",
        pageUrl: request.pageUrl || sender.tab?.url,
        tabId: sender.tab?.id,
        autoLaunch: request.autoLaunch !== false,
        filename: fileNameFromUrl(request.url),
        method: request.method,
        body: request.body
      });
      return { ok: true };
    case "SEB_PROCESS_BYTES":
      await processBytes(new Uint8Array(request.bytes), {
        source: request.source || "selected file",
        filename: request.filename || "configuration.seb",
        autoLaunch: true
      });
      return { ok: true };
    case "SEB_UNLOCK":
      return unlockPending(request.password);
    case "SEB_GET_STATE":
      return { ok: true, state: withHeaderDemo(await loadState()) };
    case "SEB_GET_SETTINGS":
      return { ok: true, settings: await loadSettings() };
    case "SEB_SET_SETTINGS": {
      const settings = await saveSettings(request.settings || {});
      await broadcastPresentation(settings);
      return { ok: true, settings };
    }
    case "SEB_GET_PAGE_PRESENTATION": {
      const state = await loadState();
      const transition = pageTransitions.get(sender.tab?.id);
      return {
        ok: true,
        presentation: {
          loaded: state.status === "ready"
            && presentationTabs.has(sender.tab?.id)
            && isWebUrl(sender.tab?.url),
          afterReload: transition?.phase === "reloading",
          settings: buildPresentationSettings(await loadSettings(), state.xml)
        }
      };
    }
    case "SEB_STARTUP_FINISHED":
      await beginPendingReload(sender.tab?.id);
      return { ok: true };
    case "SEB_TRANSITION_FINISHED":
      if (Number.isInteger(sender.tab?.id)) pageTransitions.delete(sender.tab.id);
      return { ok: true };
    case "SEB_GET_QUIT_REQUIREMENTS": {
      const state = await loadState();
      if (state.status !== "ready" || !presentationTabs.has(sender.tab?.id)) {
        return { ok: false, error: "No SEB configuration is loaded in this tab." };
      }
      const quit = getSebQuitSettings(state.xml);
      return { ok: true, allowQuit: quit.allowQuit, passwordRequired: quit.passwordRequired };
    }
    case "SEB_QUIT": {
      const state = await loadState();
      if (state.status !== "ready" || !presentationTabs.has(sender.tab?.id)) {
        return { ok: false, error: "No SEB configuration is loaded in this tab." };
      }
      const quit = getSebQuitSettings(state.xml);
      if (!quit.allowQuit) return { ok: false, error: "Quitting is disabled by this SEB configuration." };
      if (!request.confirmed) return { ok: false, error: "Quit confirmation is required." };
      if (!await verifySebQuitPassword(state.xml, request.password || "")) {
        return { ok: false, error: "Incorrect quit password." };
      }
      await unloadConfiguration({ closeTabs: true });
      return { ok: true };
    }
    case "SEB_HEADER_ENABLE":
      await enableHeaderInjection(request.configHash);
      return { ok: true, headerDemo: await reloadActiveHeaderTab() };
    case "SEB_HEADER_DISABLE":
      return { ok: true, headerDemo: await disableHeaderInjection() };
    case "SEB_UNLOAD":
      await unloadConfiguration({ reloadTabs: true });
      return { ok: true };
    case "SEB_CLEAR":
      await unloadConfiguration();
      return { ok: true };
    default:
      return { ok: false, error: "Unknown request." };
  }
}

async function processUrl(originalUrl, metadata = {}) {
  let embedded;
  try {
    embedded = decodeEmbeddedSebUrl(originalUrl);
  } catch (error) {
    await saveState({ status: "error", message: error.message, errorCode: error.code });
    setBadge("!", "#dc2626");
    return;
  }

  if (embedded) {
    const duplicateKey = `embedded:${embedded.length}:${originalUrl.slice(-32)}`;
    const now = Date.now();
    if (now - (duplicateRequests.get(duplicateKey) || 0) < 8_000) return;
    duplicateRequests.set(duplicateKey, now);
    await processBytes(embedded, {
      ...metadata,
      sourceUrl: "Embedded in SEB launch URL",
      filename: metadata.filename || "embedded-configuration.seb"
    });
    return;
  }

  let url;
  try {
    url = normalizeSebUrl(originalUrl);
  } catch {
    return;
  }

  const now = Date.now();
  const previous = duplicateRequests.get(url) || 0;
  if (now - previous < 8_000) return;
  duplicateRequests.set(url, now);

  await saveState({
    status: "downloading",
    sourceUrl: url,
    filename: metadata.filename || fileNameFromUrl(url),
    detectedAt: new Date().toISOString(),
    message: "Downloading the detected SEB configuration…"
  });
  setBadge("…", "#334155");

  try {
    const options = {
      method: metadata.method || "GET",
      credentials: "include",
      redirect: "follow",
      cache: "no-store"
    };
    if (options.method === "POST" && metadata.body) {
      options.headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
      options.body = metadata.body;
    }

    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    await processBytes(bytes, {
      ...metadata,
      sourceUrl: response.url || url,
      filename: metadata.filename || fileNameFromResponse(response) || fileNameFromUrl(response.url || url)
    });
  } catch (error) {
    await saveState({
      status: "error",
      sourceUrl: url,
      filename: metadata.filename || fileNameFromUrl(url),
      detectedAt: new Date().toISOString(),
      message: `Could not retrieve the detected file: ${error.message}`
    });
    setBadge("!", "#dc2626");
  }

}

async function processBytes(bytes, metadata) {
  await disableHeaderInjection();
  try {
    const result = await inspectSebFile(bytes);
    if (result.status === "password-needed") {
      await browser.storage.session.set({
        [PENDING_KEY]: { bytes: Array.from(bytes), metadata, mode: result.mode }
      });
      await saveState({
        status: "password-needed",
        mode: result.mode,
        sourceUrl: metadata.sourceUrl,
        filename: metadata.filename,
        detectedAt: new Date().toISOString(),
        message: result.message
      });
      setBadge("?", "#d97706");
      return;
    }

    await browser.storage.session.remove(PENDING_KEY);
    await saveState({
      status: "ready",
      mode: result.mode,
      xml: result.xml,
      sourceUrl: metadata.sourceUrl,
      filename: metadata.filename,
      detectedAt: new Date().toISOString(),
      message: "SEB configuration decoded successfully."
    });
    setBadge("✓", "#16a34a");
    if (metadata.autoLaunch) await activateLaunch(result.xml, metadata);
  } catch (error) {
    await saveState({
      status: "error",
      sourceUrl: metadata.sourceUrl,
      filename: metadata.filename,
      detectedAt: new Date().toISOString(),
      errorCode: error instanceof SebParseError ? error.code : "UNKNOWN",
      message: error.message
    });
    setBadge("!", "#dc2626");
  }
}

async function unlockPending(password) {
  const stored = await browser.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY];
  if (!pending) return { ok: false, error: "The pending SEB file is no longer available." };

  try {
    const result = await inspectSebFile(new Uint8Array(pending.bytes), password);
    await browser.storage.session.remove(PENDING_KEY);
    await saveState({
      status: "ready",
      mode: result.mode,
      xml: result.xml,
      sourceUrl: pending.metadata.sourceUrl,
      filename: pending.metadata.filename,
      detectedAt: new Date().toISOString(),
      message: "Password accepted. SEB configuration decoded successfully."
    });
    setBadge("✓", "#16a34a");
    if (pending.metadata.autoLaunch) await activateLaunch(result.xml, pending.metadata);
    return { ok: true };
  } catch (error) {
    if (error instanceof SebParseError && error.code === "INVALID_PASSWORD") {
      await saveState({
        status: "password-needed",
        mode: pending.mode,
        sourceUrl: pending.metadata.sourceUrl,
        filename: pending.metadata.filename,
        detectedAt: new Date().toISOString(),
        message: "That password did not unlock the file. Please try again.",
        passwordError: true
      });
      return { ok: false, error: "Incorrect password." };
    }
    await browser.storage.session.remove(PENDING_KEY);
    await saveState({
      status: "error",
      sourceUrl: pending.metadata.sourceUrl,
      filename: pending.metadata.filename,
      detectedAt: new Date().toISOString(),
      errorCode: error instanceof SebParseError ? error.code : "UNKNOWN",
      message: error.message
    });
    setBadge("!", "#dc2626");
    return { ok: false, error: error.message };
  }
}

async function saveState(state) {
  await browser.storage.session.set({ [STATE_KEY]: state });
}

async function loadState() {
  const stored = await browser.storage.session.get(STATE_KEY);
  return stored[STATE_KEY] || { status: "idle", message: "Waiting for a SEB download or launch link." };
}

function withHeaderDemo(state) {
  return { ...state, headerDemo: getHeaderStatus() };
}

function setBadge(text, color) {
  const browserAction = browser.browserAction || browser.action;
  browserAction.setBadgeText({ text });
  browserAction.setBadgeBackgroundColor({ color });
}

async function activateLaunch(xml, metadata) {
  const configHash = await calculateSebConfigHash(xml);
  const configuredStartUrl = getSebStartUrl(xml);
  const destination = isWebUrl(configuredStartUrl)
    ? configuredStartUrl
    : isWebUrl(metadata.pageUrl) ? metadata.pageUrl : undefined;
  if (!destination) {
    throw new Error("The SEB configuration does not contain a valid HTTP or HTTPS start URL.");
  }

  const settings = buildPresentationSettings(await loadSettings(), xml);
  const targetTab = await findTargetTab(metadata.tabId);
  if (!targetTab) throw new Error("Open an HTTP or HTTPS page before loading the SEB configuration.");
  await enableHeaderInjection(configHash);
  await broadcastMessage({ type: "SEB_UNLOAD_PRESENTATION" });
  presentationTabs.clear();
  presentationTabs.add(targetTab.id);
  await transitionToDestination(targetTab.id, destination, settings);

  const state = await loadState();
  await saveState({
    ...state,
    cmid: getMoodleCmid(destination),
    message: "SEB configuration decoded. Request headers are enabled and the configured page was loaded."
  });
}

async function findTargetTab(preferredTabId) {
  const tabs = (await browser.tabs.query({})).filter((tab) => Number.isInteger(tab.id) && isWebUrl(tab.url));
  return tabs.find((tab) => tab.id === preferredTabId)
    || tabs.find((tab) => tab.active)
    || tabs[0];
}

async function transitionToDestination(tabId, destination, settings) {
  if (settings.showStartupAnimation) {
    pageTransitions.set(tabId, { phase: "startup", destination });
    try {
      await browser.tabs.sendMessage(tabId, { type: "SEB_SHOW_STARTUP", settings });
      return;
    } catch {
      // If the old document has no content script, fall through to a direct reload.
    }
  }
  pageTransitions.set(tabId, { phase: "reloading", destination });
  await browser.tabs.update(tabId, { url: destination });
}

async function beginPendingReload(tabId) {
  const transition = pageTransitions.get(tabId);
  if (!transition || transition.phase !== "startup") return;
  transition.phase = "reloading";
  pageTransitions.set(tabId, transition);
  await browser.tabs.update(tabId, { url: transition.destination });
}

async function unloadConfiguration({ closeTabs = false, reloadTabs = false } = {}) {
  const state = await loadState();
  const targetTabIds = [...presentationTabs];
  if (state.cmid) {
    await Promise.all(targetTabIds.map((tabId) => browser.tabs.sendMessage(tabId, {
      type: "SEB_RESET_MOODLE_ACCESS",
      cmid: state.cmid
    }).catch(() => ({ ok: false }))));
  }
  await disableHeaderInjection();
  pageTransitions.clear();
  await browser.storage.session.remove(PENDING_KEY);
  await saveState({ status: "idle", message: "No SEB configuration is loaded." });
  setBadge("", "#334155");
  await broadcastMessage({ type: "SEB_UNLOAD_PRESENTATION" });
  presentationTabs.clear();
  if (closeTabs && targetTabIds.length) {
    await browser.tabs.remove(targetTabIds).catch(() => {});
  } else if (reloadTabs) {
    await Promise.all(targetTabIds.map((tabId) => browser.tabs.reload(tabId).catch(() => {})));
  }
}

async function loadSettings() {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const saved = stored[SETTINGS_KEY] || {};
  const legacyMode = typeof saved.showSebBar === "boolean" ? (saved.showSebBar ? "auto" : "hide") : undefined;
  return {
    showStartupAnimation: saved.showStartupAnimation !== false,
    taskbarMode: ["auto", "show", "hide"].includes(saved.taskbarMode) ? saved.taskbarMode : legacyMode || "auto",
    taskbarScale: normalizeTaskbarScale(saved.taskbarScale)
  };
}

async function saveSettings(next) {
  const settings = {
    showStartupAnimation: next.showStartupAnimation !== false,
    taskbarMode: ["auto", "show", "hide"].includes(next.taskbarMode) ? next.taskbarMode : "auto",
    taskbarScale: normalizeTaskbarScale(next.taskbarScale)
  };
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

function normalizeTaskbarScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) ? Math.max(50, Math.min(300, Math.round(scale))) : 100;
}

async function broadcastPresentation(settings) {
  const state = await loadState();
  if (state.status !== "ready") return;
  await broadcastMessage({ type: "SEB_APPLY_PRESENTATION", settings: buildPresentationSettings(settings, state.xml) });
}

function buildPresentationSettings(settings, xml) {
  let config = getSebPresentationSettings(`<?xml version="1.0"?><plist version="1.0"><dict/></plist>`);
  if (xml) {
    try { config = getSebPresentationSettings(xml); } catch { /* Use native SEB defaults. */ }
  }
  return { ...settings, config };
}

async function broadcastMessage(message) {
  const tabs = (await browser.tabs.query({})).filter((tab) =>
    Number.isInteger(tab.id) && presentationTabs.has(tab.id) && isWebUrl(tab.url)
  );
  await Promise.all(tabs.map((tab) => browser.tabs.sendMessage(tab.id, message).catch(() => {})));
}

function isWebUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function getMoodleCmid(value) {
  try {
    const url = new URL(value);
    if (!isWebUrl(url.href) || !url.pathname.includes("/mod/quiz/")) return undefined;
    const id = Number.parseInt(url.searchParams.get("id") || "", 10);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSebUrl(value) {
  if (typeof value !== "string") throw new TypeError("Invalid URL.");
  if (/^sebs:\/\//i.test(value)) return `https://${value.slice(value.indexOf("://") + 3)}`;
  if (/^seb:\/\//i.test(value)) return `http://${value.slice(value.indexOf("://") + 3)}`;
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("Unsupported URL.");
  return parsed.href;
}

function isSebUrl(value = "") {
  return /^(?:sebs?):\/\//i.test(value) || /(?:^|[/?=&])[^/?=&]*\.seb(?:$|[?#&])/i.test(value);
}

function isSebMime(value = "") {
  return /^(?:application\/(?:x-)?seb|application\/safe-exam-browser)$/i.test(value.trim());
}

function fileNameFromDisposition(value = "") {
  const utf = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf) return decodeURIComponent(utf[1].replace(/["']/g, ""));
  const plain = value.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain?.[1]?.trim();
}

function fileNameFromResponse(response) {
  return fileNameFromDisposition(response.headers.get("content-disposition") || "");
}

function fileNameFromUrl(value = "") {
  try {
    const name = decodeURIComponent(new URL(normalizeSebUrl(value)).pathname.split("/").pop() || "");
    return name || "configuration.seb";
  } catch {
    return "configuration.seb";
  }
}

function fileNameFromPath(value = "") {
  return value.split(/[\\/]/).pop() || "";
}
