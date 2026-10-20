import { calculateRequestConfigKeySync } from "./config-key.js";
import { resolveBrowserExamKey, calculateRequestBrowserExamKeySync, normalizeBekSettings, DEFAULT_BUILD_VERSION } from "./browser-exam-key.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
const CONFIG_HEADER = "X-SafeExamBrowser-ConfigKeyHash";
const BEK_HEADER = "X-SafeExamBrowser-RequestHash";
const WEB_URL_PATTERNS = ["<all_urls>"];

let enabled = false;
let configHash;
let matchingTabs = 0;
let lastError;
let browserExamKey;
let buildVersion = DEFAULT_BUILD_VERSION;
let examOrigin;
let bekMode = "disabled";
let requestsWithBek = 0;

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!enabled || !configHash || !isAllowedUrl(details.url) || new URL(details.url).origin !== examOrigin) return {};

    try {
      const requestKey = calculateRequestConfigKeySync(details.url, configHash);
      const requestHeaders = (details.requestHeaders || [])
        .filter(({ name }) => !["user-agent", CONFIG_HEADER.toLowerCase(), BEK_HEADER.toLowerCase()].includes(name.toLowerCase()));
      requestHeaders.push({ name: "User-Agent", value: `${USER_AGENT} SEB/${buildVersion.split(".").slice(0, 3).join(".")} (x64)` });
      requestHeaders.push({ name: CONFIG_HEADER, value: requestKey });
      if (browserExamKey) {
        requestHeaders.push({ name: BEK_HEADER, value: calculateRequestBrowserExamKeySync(details.url, browserExamKey) });
        requestsWithBek += 1;
      }
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

export async function enableHeaderInjection(hash, { xml, origin, settings = {} } = {}) {
  if (!/^[a-f\d]{64}$/i.test(hash || "")) throw new Error("Invalid SEB configuration hash.");
  if (!isAllowedUrl(origin)) throw new Error("The exam must have an HTTP or HTTPS start URL.");
  const normalized = normalizeBekSettings(settings);
  const resolved = await resolveBrowserExamKey(xml, hash, normalized);
  await refreshMatchingTabs(null);
  if (matchingTabs === 0) throw new Error("Open an HTTP or HTTPS page before enabling SEB request headers.");
  configHash = hash.toLowerCase();
  browserExamKey = resolved.key;
  bekMode = resolved.mode;
  requestsWithBek = 0;
  buildVersion = normalized.buildVersion;
  examOrigin = new URL(origin).origin;
  enabled = true;
  lastError = undefined;
  await refreshMatchingTabs();

  return getHeaderStatus();
}

export async function disableHeaderInjection() {
  enabled = false;
  configHash = undefined;
  browserExamKey = undefined;
  bekMode = "disabled";
  requestsWithBek = 0;
  examOrigin = undefined;
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
    examOrigin,
    buildVersion,
    bekMode,
    requestsWithBek,
    error: lastError
  };
}

async function refreshMatchingTabs(origin = examOrigin) {
  const tabs = await browser.tabs.query({});
  matchingTabs = tabs.filter((tab) => isAllowedUrl(tab.url) && (!origin || new URL(tab.url).origin === origin)).length;
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
