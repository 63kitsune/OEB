import { askWithFallback, normalizeProviderAccounts } from "./providers.js";

const PROVIDERS_KEY = "oebAiProviders";
const NOTE_KEY = "oebAiNote";
const DOMAINS_KEY = "oebAiEnabledDomains";
const LAST_RUN_KEY = "oebAiLastRun";
const runningTabs = new Map();

function questionFingerprint(questions) {
  return JSON.stringify(questions, (key, value) => key === "dataUrl" ? undefined : value);
}

function withoutImageData(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => key === "dataUrl" ? undefined : item));
}

export function installAssistantCommands() {
  browser.commands?.onCommand.addListener((command, tab) => {
    if (command === "answer-questions") answerTab(tab?.id).catch(() => {});
  });
}

export async function answerTab(requestedTabId) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || (requestedTabId && tab.id !== requestedTabId)) {
    throw new Error("The active tab changed.");
  }

  const url = new URL(tab.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Open a Moodle quiz page first.");
  if (runningTabs.has(tab.id)) return runningTabs.get(tab.id);

  const work = runAssistant(tab, url).finally(() => runningTabs.delete(tab.id));
  runningTabs.set(tab.id, work);
  return work;
}

async function runAssistant(tab, url) {
  const current = { tabId: tab.id, url: tab.url };
  try {
    const stored = await browser.storage.local.get([DOMAINS_KEY, PROVIDERS_KEY, NOTE_KEY]);
    const enabledDomains = stored[DOMAINS_KEY] || {};
    const providers = normalizeProviderAccounts(stored[PROVIDERS_KEY]);
    if (!enabledDomains[url.hostname.toLowerCase()]) {
      throw new Error("Enable AI autofill for this domain in the OEB popup first.");
    }
    if (!providers.some((provider) => provider.enabled)) {
      throw new Error("Add and enable at least one AI provider in the OEB popup.");
    }

    await setBadge(tab.id, "…", "#2563eb");
    const extracted = await browser.tabs.sendMessage(tab.id, { type: "OEB_AI_EXTRACT" });
    if (!extracted?.ok) throw new Error(extracted?.error || "Could not read questions from the page.");
    const questions = extracted.questions || [];
    if (!questions.length) throw new Error("No Moodle questions were found on this page.");

    const ai = await askWithFallback(providers, questions, stored[NOTE_KEY]);
    const after = await browser.tabs.get(tab.id);
    if (after.url !== tab.url) throw new Error("The page navigated while the AI provider was answering.");

    const freshResponse = await browser.tabs.sendMessage(tab.id, { type: "OEB_AI_EXTRACT" });
    if (!freshResponse?.ok) throw new Error(freshResponse?.error || "Could not re-check the page.");
    if (questionFingerprint(freshResponse.questions) !== questionFingerprint(questions)) {
      throw new Error("Questions changed while the AI provider was answering.");
    }

    const applied = ai.answers.length
      ? await browser.tabs.sendMessage(tab.id, { type: "OEB_AI_APPLY", answers: ai.answers })
      : { ok: true, results: [] };
    if (!applied?.ok) throw new Error(applied?.error || "Could not fill answers on the page.");

    const results = applied.results || [];
    const filled = results.filter((item) => item.status === "filled").length;
    const color = filled === ai.answers.length ? "#15803d" : "#b45309";
    await setBadge(tab.id, String(filled), color);
    return saveRun({
      ...current,
      questions: withoutImageData(questions),
      answers: ai.answers,
      results,
      provider: ai.provider,
      attempts: ai.attempts,
      message: `${filled}/${questions.length} questions filled using ${ai.provider}. Review before submitting.`
    });
  } catch (error) {
    await setBadge(tab.id, "!", "#b91c1c");
    return saveRun({
      ...current,
      error: error.message,
      attempts: error.attempts || [],
      message: `AI autofill failed: ${error.message}`
    });
  }
}

async function setBadge(tabId, text, color) {
  await browser.browserAction.setBadgeBackgroundColor({ tabId, color });
  await browser.browserAction.setBadgeText({ tabId, text });
}

async function saveRun(data) {
  const value = { ...data, time: Date.now() };
  await browser.storage.local.set({ [LAST_RUN_KEY]: value });
  return value;
}
