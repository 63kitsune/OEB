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
import { DEFAULT_BEK_SETTINGS, normalizeBekSettings } from "./browser-exam-key.js";
import { isSebConfigurationUrl, classifySebResponse } from "./launch-response.js";

import { SETTINGS_KEY, DEFAULT_SETTINGS, normalizeSettings } from "./settings.js";
import { shouldProbeDownload, probeSebDownload, containsSebConfiguration } from "./download-check.js";

import { mirrorDownloadResponse, isExtensionlessResponse } from "./download-stream.js";

const BEK_SETTINGS_KEY = "oebBekSettings";

const STATE_KEY = "sebInspectorState";
const PENDING_KEY = "sebInspectorPending";
let automaticDownloads = false;
const settingsReady = loadSettings().then(settings => { automaticDownloads = settings.checkDownloadsForSeb; });
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) {
    automaticDownloads = normalizeSettings(changes[SETTINGS_KEY].newValue).checkDownloadsForSeb;
  }
});
const duplicateRequests = new Map();
const inFlightCaptures = new Map();
const inFlightProbes = new Map();
const automaticCaptures = new Map();
let loadedBytesDigest;
const responseCaptures = new Map();
const sebResponseRequests = new Set();
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

browser.downloads.onCreated.addListener(async (item) => {
  await settingsReady;
  if (!automaticDownloads) return;
  const url = item.finalUrl || item.url;
  const mirrored = responseCaptures.get(url);
  if (mirrored && await mirrored) return;
  if (isSebUrl(url) || item.filename?.toLowerCase().endsWith(".seb") || isSebMime(item.mime)) {
    await processUrl(url, {
      source: "browser download",
      autoLaunch: true,
      filename: fileNameFromPath(item.filename) || fileNameFromUrl(url)
    });
  } else if (/^https?:\/\//i.test(url || "")) {
    // Download requests can have tabId -1 and arbitrary names/MIME types. The
    // browser download event is the fallback when the response hook cannot help.
    await inspectUnknownDownload({ url, type: "download", tabId: item.tabId }, false, {
      source: "browser download content check",
      filename: fileNameFromPath(item.filename) || fileNameFromUrl(url),
      pageUrl: item.referrer
    });
  }
});

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    const extensionRoot = browser.runtime.getURL?.("");
    if (extensionRoot && [details.originUrl, details.documentUrl, details.initiator]
      .some(value => value?.startsWith(extensionRoot))) return;
    if (details.tabId < 0 && !browser.webRequest.filterResponseData) return;
    // Firefox supports an asynchronous blocking response. Chromium requires a synchronous one.
    if (browser.runtime.getBrowserInfo) return settingsReady.then(() => inspectDownloadResponse(details, true));
    return inspectDownloadResponse(details, false);
  },
  { urls: ["<all_urls>"] },
  ["blocking", "responseHeaders"]
);

function inspectDownloadResponse(details, canWait) {
    if (!automaticDownloads) return {};
    if (browser.webRequest.filterResponseData && isExtensionlessResponse(details)) {
      try {
        const filter = browser.webRequest.filterResponseData(details.requestId);
        const pending = mirrorDownloadResponse(filter, async bytes => {
          if (!automaticDownloads || !await containsSebConfiguration(bytes)) return false;
          return captureAutomaticBytes(bytes, details);
        });
        responseCaptures.set(details.url, pending);
        // Retain the completed decision briefly for a late downloads.onCreated event.
        pending.finally(() => {
          const timer = setTimeout(() => {
            if (responseCaptures.get(details.url) === pending) responseCaptures.delete(details.url);
          }, 8000);
          timer.unref?.();
        });
        return {};
      } catch { /* Fall back to the browser download probe. */ }
    }
    if (details.tabId < 0) return {};

    const { recognized, consume, disposition } = classifySebResponse({
      ...details, knownSebRequest: sebResponseRequests.has(details.requestId)
    });
    if (recognized && details.statusCode >= 300 && details.statusCode < 400) {
      sebResponseRequests.add(details.requestId);
    }

    if (recognized && details.statusCode >= 200 && details.statusCode < 300) {
      processUrl(details.url, {
        source: "SEB response",
        tabId: details.tabId,
        autoLaunch: true,
        filename: fileNameFromDisposition(disposition) || fileNameFromUrl(details.url)
      });
    }
    if (!recognized && shouldProbeDownload(details)) {
      const probe = inspectUnknownDownload(details, canWait);
      return canWait ? probe : {};
    }
    return consume ? { cancel: true } : {};
}

async function probeDownloadOnce(url, tabId) {
  if (inFlightProbes.has(url)) return inFlightProbes.get(url);
  const pending = (async () => {
    // Use the originating page's authenticated session before the background fallback.
    const tabs = await browser.tabs.query({});
    const tab = tabs.find(tab => tab.id === tabId) || tabs.find(tab => tab.active && isWebUrl(tab.url))
      || tabs.find(tab => presentationTabs.has(tab.id) && isWebUrl(tab.url));
    if (tab) {
      try {
        const response = await browser.tabs.sendMessage(tab.id, { type: "SEB_PROBE_DOWNLOAD_URL", url }, { frameId: 0 });
        if (Array.isArray(response?.bytes) && response.bytes.length <= 8 * 1024 * 1024) {
          const bytes = new Uint8Array(response.bytes);
          return await containsSebConfiguration(bytes) ? bytes : null;
        }
      } catch { /* The page may not have the new content script until reloaded. */ }
    }
    return probeSebDownload(url);
  })();
  inFlightProbes.set(url, pending);
  try { return await pending; }
  finally { inFlightProbes.delete(url); }
}

async function inspectUnknownDownload(details, canWait, metadata = {}) {
  const bytes = await probeDownloadOnce(details.url, details.tabId);
  if (!bytes || !automaticDownloads) return {};
  const accepted = await captureAutomaticBytes(bytes, details, metadata);
  return accepted && canWait && ["main_frame", "sub_frame"].includes(details.type) ? { cancel: true } : {};
}

async function digestBytes(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    value => value.toString(16).padStart(2, "0")).join("");
}

async function captureAutomaticBytes(bytes, details, metadata = {}) {
  try {
    const parsed = await inspectSebFile(bytes);
    if (parsed.status === "ready") await calculateSebConfigHash(parsed.xml);
  } catch { return false; }
  const digest = await digestBytes(bytes);
  const key = `${details.url}:${digest}`;
  if (automaticCaptures.has(key)) return automaticCaptures.get(key);
  const state = await loadState();
  // Deduplicate only the currently loaded bytes. A -> B -> A must always load A again.
  if (loadedBytesDigest === digest && ["ready", "password-needed"].includes(state.status)) return true;
  const pending = processBytes(bytes, {
    source: "automatic download check", sourceUrl: details.url,
    tabId: details.tabId, autoLaunch: true, filename: fileNameFromUrl(details.url), ...metadata
  }).then(result => result !== false);
  automaticCaptures.set(key, pending);
  try { return await pending; }
  finally { if (automaticCaptures.get(key) === pending) automaticCaptures.delete(key); }
}

for (const event of [browser.webRequest.onCompleted, browser.webRequest.onErrorOccurred]) {
  event.addListener(details => sebResponseRequests.delete(details.requestId), { urls: ["<all_urls>"] });
}

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
      const captured = await loadState();
      return { ok: captured.status !== "error", state: captured,
        error: captured.status === "error" ? captured.message : undefined };
    case "SEB_CHECK_DOWNLOAD_BYTES": {
      await settingsReady;
      if (!automaticDownloads || !Array.isArray(request.bytes) || request.bytes.length > 8 * 1024 * 1024) {
        return { ok: true, recognized: false };
      }
      const bytes = new Uint8Array(request.bytes);
      try {
        if (!await containsSebConfiguration(bytes)) return { ok: true, recognized: false };
        const parsed = await inspectSebFile(bytes);
        if (parsed.status === "ready") await calculateSebConfigHash(parsed.xml);
      } catch { return { ok: true, recognized: false }; }
      const accepted = await captureAutomaticBytes(bytes, { url: request.sourceUrl || "page download", tabId: sender.tab?.id }, {
        source: "page download", filename: request.filename || "download", pageUrl: sender.tab?.url || request.pageUrl });
      const state = await loadState();
      return { ok: accepted, recognized: true, state,
        error: state.status === "error" ? state.message : undefined };
    }
    case "SEB_PROCESS_BYTES": {
      await processBytes(new Uint8Array(request.bytes), {
        source: request.source || "selected file",
        filename: request.filename || "configuration.seb",
        tabId: Number.isInteger(request.tabId) ? request.tabId : sender.tab?.id,
        autoLaunch: true
      });
      const state = await loadState();
      return { ok: state.status !== "error", state,
        error: state.status === "error" ? state.message : undefined };
    }
    case "SEB_UNLOCK":
      return unlockPending(request.password);
    case "SEB_GET_STATE":
      return { ok: true, state: withHeaderDemo(await loadState()) };
    case "SEB_GET_SETTINGS":
      return { ok: true, settings: await loadSettings() };
    case "SEB_GET_BEK_SETTINGS":
      return { ok: true, settings: await loadBekSettings() };
    case "SEB_SET_BEK_SETTINGS": {
      const settings = normalizeBekSettings(request.settings);
      if (settings.enabled && settings.mode === "provided" && !settings.browserExamKey) {
        throw new Error("Paste a BEK or choose automatic calculation.");
      }
      const state = await loadState();
      if (getHeaderStatus().enabled && state.status === "ready") await enableLoadedHeaders(state.xml, settings);
      await browser.storage.local.set({ [BEK_SETTINGS_KEY]: settings });
      return { ok: true, settings };
    }
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
      await unloadConfiguration({ closeTabs: (await loadSettings()).closeTabOnQuit });
      return { ok: true };
    }
    case "SEB_HEADER_ENABLE": {
      const state = await loadState();
      if (state.status !== "ready") throw new Error("Load a SEB configuration first.");
      await enableLoadedHeaders(state.xml);
      return { ok: true, headerDemo: await reloadActiveHeaderTab() };
    }
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
  if (inFlightCaptures.has(originalUrl)) return inFlightCaptures.get(originalUrl);
  const pending = processUrlOnce(originalUrl, metadata);
  inFlightCaptures.set(originalUrl, pending);
  try {
    return await pending;
  } finally {
    inFlightCaptures.delete(originalUrl);
  }
}

async function processUrlOnce(originalUrl, metadata = {}) {
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
      cache: "no-store",
      signal: AbortSignal.timeout(30_000)
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
      message: error.name === "TimeoutError"
        ? "The configuration download timed out. Check the link and your connection, then try again."
        : `Could not retrieve the detected file: ${error.message}`
    });
    setBadge("!", "#dc2626");
  }

}

let configurationQueue = Promise.resolve();
function processBytes(bytes, metadata) {
  const pending = configurationQueue.catch(() => {}).then(() => replaceConfiguration(bytes, metadata));
  configurationQueue = pending;
  return pending;
}

async function replaceConfiguration(bytes, metadata) {
  try {
    const result = await inspectSebFile(bytes);
    if (result.status === "ready") await calculateSebConfigHash(result.xml);
    // Unload the old exam before overwriting its state, including its overlay,
    // transitions and pending password. This also works when an exam is already loaded.
    await unloadConfiguration();
    loadedBytesDigest = await digestBytes(bytes);
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
      return true;
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
    return true;
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
    return false;
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
  await enableHeaderInjection(configHash, { xml, origin: destination, settings: await loadBekSettings() });
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
  loadedBytesDigest = undefined;
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
  return normalizeSettings(stored[SETTINGS_KEY]);
}

async function loadBekSettings() {
  const stored = await browser.storage.local.get(BEK_SETTINGS_KEY);
  const saved = stored[BEK_SETTINGS_KEY];
  if (saved && saved.schemaVersion !== 2 && saved.mode === "provided" && !saved.browserExamKey) {
    return normalizeBekSettings({ ...saved, mode: "automatic" });
  }
  return normalizeBekSettings(saved || DEFAULT_BEK_SETTINGS);
}

async function enableLoadedHeaders(xml, settings) {
  return enableHeaderInjection(await calculateSebConfigHash(xml), {
    xml,
    origin: getSebStartUrl(xml),
    settings: settings || await loadBekSettings()
  });
}

async function saveSettings(next) {
  const settings = normalizeSettings({ ...await loadSettings(), ...next });
  automaticDownloads = settings.checkDownloadsForSeb;
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
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
  return isSebConfigurationUrl(value);
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
