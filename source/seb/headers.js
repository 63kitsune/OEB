import { calculateRequestConfigKeySync } from "./config-key.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 SEB/3.7.0 (x64)";
const CONFIG_HEADER = "X-SafeExamBrowser-ConfigKeyHash";
const WEB_URL_PATTERNS = ["<all_urls>"];

let enabled = false;
let configHash;
let matchingTabs = 0;
let lastError;

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!enabled || !configHash || !isAllowedUrl(details.url)) return {};

    try {
      const requestKey = calculateRequestConfigKeySync(details.url, configHash);
      const requestHeaders = (details.requestHeaders || [])
        .filter(({ name }) => !["user-agent", CONFIG_HEADER.toLowerCase()].includes(name.toLowerCase()));
      requestHeaders.push({ name: "User-Agent", value: USER_AGENT });
      requestHeaders.push({ name: CONFIG_HEADER, value: requestKey });
      return { requestHeaders };
    } catch (error) {
      lastError = error.message;
      return {};
    }
  },
  { urls: WEB_URL_PATTERNS },
  browser.runtime.getBrowserInfo
    ? ["blocking", "requestHeaders"]
    : ["blocking", "requestHeaders", "extraHeaders"]
);

browser.tabs.onRemoved.addListener(() => {
  if (enabled) refreshMatchingTabs().catch(recordError);
});

browser.tabs.onUpdated.addListener(() => {
  if (enabled) refreshMatchingTabs().catch(recordError);
});

export async function enableHeaderInjection(hash) {
  if (!/^[a-f\d]{64}$/i.test(hash || "")) throw new Error("Invalid SEB configuration hash.");
  configHash = hash.toLowerCase();
  enabled = true;
  lastError = undefined;
  await refreshMatchingTabs();

  if (matchingTabs === 0) {
    const error = "Open an HTTP or HTTPS page before enabling SEB request headers.";
    enabled = false;
    configHash = undefined;
    lastError = error;
    throw new Error(error);
  }

  return getHeaderStatus();
}

export async function disableHeaderInjection() {
  enabled = false;
  configHash = undefined;
  matchingTabs = 0;
  lastError = undefined;
  return getHeaderStatus();
}

export async function reloadActiveHeaderTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs.find((tab) => Number.isInteger(tab.id) && isAllowedUrl(tab.url));
  if (activeTab) await browser.tabs.reload(activeTab.id);
  await refreshMatchingTabs();
  return getHeaderStatus();
}

export function getHeaderStatus() {
  return {
    enabled,
    attachedTabs: matchingTabs,
    urlPatterns: [...WEB_URL_PATTERNS],
    error: lastError
  };
}

async function refreshMatchingTabs() {
  const tabs = await browser.tabs.query({});
  matchingTabs = tabs.filter((tab) => isAllowedUrl(tab.url)).length;
}

function isAllowedUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function recordError(error) {
  lastError = error.message;
}
