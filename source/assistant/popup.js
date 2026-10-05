import {
  PROVIDERS,
  fetchProviderModels,
  modelImageCapability,
  newProviderAccount,
  normalizeProviderAccounts,
  providerDisplayName,
  validateProviderAccount
} from "./providers.js";

const PROVIDERS_KEY = "oebAiProviders";
const NOTE_KEY = "oebAiNote";
const DOMAINS_KEY = "oebAiEnabledDomains";
const LAST_RUN_KEY = "oebAiLastRun";
const NEXT_SHORTCUT_KEY = "oebNextPageShortcut";
const DEFAULT_NEXT_SHORTCUT = "Ctrl+Shift+X";
const byId = (id) => document.getElementById(id);

const elements = {
  viewTabs: [...document.querySelectorAll(".viewTab")],
  sebView: byId("sebView"),
  assistantView: byId("assistantView"),
  domain: byId("assistantDomain"),
  note: byId("assistantNote"),
  noteStatus: byId("assistantNoteStatus"),
  enabled: byId("assistantEnabled"),
  providerList: byId("providerList"),
  addProvider: byId("addProvider"),
  saveProviders: byId("saveProviders"),
  providerSaveStatus: byId("providerSaveStatus"),
  refresh: byId("assistantRefresh"),
  run: byId("assistantRun"),
  copy: byId("assistantCopy"),
  status: byId("assistantStatus"),
  questions: byId("assistantQuestions"),
  results: byId("assistantResults"),
  nextShortcut: byId("nextPageShortcut"),
  resetNextShortcut: byId("resetNextPageShortcut"),
  nextShortcutStatus: byId("nextPageShortcutStatus")
};

let activeTab;
let activeDomain;
let questions = [];
let providers = [];
let busy = false;
let providersDirty = false;
const expandedProviders = new Set();
let noteSaveQueue = Promise.resolve();

elements.note.addEventListener("input", () => {
  const value = elements.note.value;
  elements.noteStatus.textContent = "Saving…";
  noteSaveQueue = noteSaveQueue.catch(() => {}).then(() => browser.storage.local.set({ [NOTE_KEY]: value.trim() }));
  noteSaveQueue.then(() => {
    if (elements.note.value === value) elements.noteStatus.textContent = "Saved";
  }).catch((error) => {
    elements.noteStatus.textContent = `Not saved: ${error.message}`;
  });
});

for (const tab of elements.viewTabs) {
  tab.addEventListener("click", () => showView(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    const index = elements.viewTabs.indexOf(tab);
    const target = event.key === "Home" ? 0 : event.key === "End" ? elements.viewTabs.length - 1
      : event.key === "ArrowRight" ? (index + 1) % elements.viewTabs.length
        : event.key === "ArrowLeft" ? (index + elements.viewTabs.length - 1) % elements.viewTabs.length : -1;
    if (target < 0) return;
    event.preventDefault();
    showView(elements.viewTabs[target].dataset.view);
    elements.viewTabs[target].focus();
  });
}

elements.addProvider.addEventListener("click", () => {
  const account = newProviderAccount("gemini");
  expandedProviders.clear();
  expandedProviders.add(account.id);
  providers.push(account);
  providersDirty = true;
  renderProviders();
  showProviderStatus("New provider added. Save when ready.");
});

elements.saveProviders.addEventListener("click", saveProviders);
elements.enabled.addEventListener("change", saveDomainSetting);
elements.refresh.addEventListener("click", readQuestions);
elements.run.addEventListener("click", runAssistant);
elements.copy.addEventListener("click", copyQuestions);
elements.nextShortcut.addEventListener("keydown", captureNextShortcut);
elements.resetNextShortcut.addEventListener("click", () => saveNextShortcut(DEFAULT_NEXT_SHORTCUT));

function showView(name) {
  const assistant = name === "assistant";
  elements.sebView.hidden = assistant;
  elements.assistantView.hidden = !assistant;
  document.getElementById("statusPill").hidden = assistant;
  for (const tab of elements.viewTabs) {
    const selected = tab.dataset.view === name;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  localStorage.setItem("oebPopupView", name);
}

function showStatus(message) {
  elements.status.textContent = message;
}

function showProviderStatus(message) {
  elements.providerSaveStatus.textContent = message;
}

function controls() {
  const readyProvider = providers.some((account) => {
    const definition = PROVIDERS[account.provider];
    if (!account.enabled || !account.model || (!account.apiKey && !definition?.apiKeyOptional)) return false;
    return account.provider !== "custom" || Boolean(account.baseUrl);
  });
  elements.refresh.disabled = busy || !activeTab || !elements.enabled.checked;
  elements.run.disabled = busy || providersDirty || !activeTab || !elements.enabled.checked || !questions.length || !readyProvider;
  elements.copy.disabled = !questions.length;
  elements.addProvider.disabled = busy;
  elements.saveProviders.disabled = busy;
}

function setQuestions(value) {
  questions = Array.isArray(value) ? value : [];
  elements.questions.textContent = JSON.stringify(questions, (key, item) => {
    if (key === "src") return "[captured from page; this local URL is not sent to AI]";
    if (key !== "dataUrl") return item;
    const bytes = Math.ceil((String(item).split(',')[1]?.length || 0) * 0.75);
    return `[embedded image: ${Math.round(bytes / 1024)} KB — sent directly to supported models]`;
  }, 2);
  controls();
}

function renderProviders() {
  elements.providerList.replaceChildren();
  if (!providers.length) {
    const empty = document.createElement("p");
    empty.className = "emptyProviders";
    empty.textContent = "No providers yet. Add one to enable AI autofill.";
    elements.providerList.append(empty);
    controls();
    return;
  }

  providers.forEach((account, index) => elements.providerList.append(createProviderRow(account, index)));
  controls();
}

function createProviderRow(account, index) {
  const definition = PROVIDERS[account.provider];
  const row = document.createElement("article");
  row.className = "providerRow";
  row.dataset.id = account.id;

  const header = document.createElement("div");
  header.className = "providerRowHeader";
  const title = document.createElement("strong");
  title.textContent = `${index + 1}. ${providerDisplayName(account)}`;
  const editor = document.createElement("details");
  editor.className = "providerEditor";
  editor.open = expandedProviders.has(account.id);
  const editorTitle = document.createElement("summary");
  editorTitle.textContent = account.model || "Account settings";
  editor.addEventListener("toggle", () => {
    if (editor.open) expandedProviders.add(account.id);
    else expandedProviders.delete(account.id);
  });
  const rowActions = document.createElement("div");
  rowActions.className = "rowActions";
  rowActions.append(
    iconButton("↑", "Move provider up", () => moveProvider(index, -1), index === 0),
    iconButton("↓", "Move provider down", () => moveProvider(index, 1), index === providers.length - 1),
    iconButton("Remove", "Remove provider", () => removeProvider(index))
  );
  header.append(title, rowActions);

  const grid = document.createElement("div");
  grid.className = "providerGrid";

  const enabled = checkboxField("Use in fallback chain", account.enabled, (checked) => {
    account.enabled = checked;
    markProvidersDirty();
  });
  enabled.classList.add("providerEnabled");

  const providerSelect = document.createElement("select");
  providerSelect.className = "providerType";
  for (const [id, item] of Object.entries(PROVIDERS)) providerSelect.add(new Option(item.name, id));
  providerSelect.value = account.provider;
  providerSelect.addEventListener("change", () => {
    account.provider = providerSelect.value;
    account.model = "";
    account.baseUrl = "";
    providersDirty = true;
    renderProviders();
    showProviderStatus("Provider type changed. Save providers before running AI autofill.");
  });

  const labelInput = textInput(account.label, "Optional name, e.g. Personal Gemini", (value) => {
    account.label = value;
    title.textContent = `${index + 1}. ${providerDisplayName(account)}`;
    markProvidersDirty();
  });
  const keyInput = textInput(account.apiKey, definition.keyPlaceholder, (value) => {
    account.apiKey = value;
    markProvidersDirty();
  }, "password");
  keyInput.autocomplete = "off";

  const modelListId = `models-${account.id}`;
  let loadedModels = [];
  const imageSupport = document.createElement("small");
  imageSupport.className = "providerStatus imageSupport";
  const updateImageSupport = () => {
    const metadata = loadedModels.find((model) => model.id === account.model);
    const capability = modelImageCapability(account, account.model, metadata);
    imageSupport.textContent = capability === true
      ? "✓ Supports image questions"
      : capability === false
        ? "Text-only model — image questions will use the next provider"
        : "Image support unknown — check this model's documentation";
    imageSupport.classList.toggle("supportsImages", capability === true);
    imageSupport.classList.toggle("textOnly", capability === false);
  };
  const modelInput = textInput(account.model, definition.modelPlaceholder, (value) => {
    account.model = value;
    editorTitle.textContent = value || "Account settings";
    updateImageSupport();
    markProvidersDirty();
  });
  modelInput.setAttribute("list", modelListId);
  const modelList = document.createElement("datalist");
  modelList.id = modelListId;

  grid.append(
    enabled,
    field("Provider", providerSelect),
    field("Display name", labelInput),
    field("API key", keyInput)
  );

  if (definition.customBaseUrl) {
    const baseInput = textInput(account.baseUrl, "https://api.example.com/v1", (value) => {
      account.baseUrl = value;
      markProvidersDirty();
    }, "url");
    grid.append(field("Base URL", baseInput));
  }

  const modelWrap = document.createElement("div");
  modelWrap.className = "modelInputRow";
  const loadButton = document.createElement("button");
  loadButton.type = "button";
  loadButton.className = "secondary smallButton";
  loadButton.textContent = "Load models";
  const modelStatus = document.createElement("small");
  modelStatus.className = "providerStatus";
  loadButton.addEventListener("click", async () => {
    loadButton.disabled = true;
    modelStatus.textContent = "Loading…";
    try {
      loadedModels = await fetchProviderModels(account);
      modelList.replaceChildren(...loadedModels.map((model) => {
        const capability = model.supportsImages === true ? "images" : model.supportsImages === false ? "text only" : "image support unknown";
        const option = new Option(`${model.id} — ${capability}`, model.id);
        option.label = `${model.id} — ${capability}`;
        return option;
      }));
      if (!account.model && loadedModels.length) {
        account.model = loadedModels.some((model) => model.id === definition.modelPlaceholder)
          ? definition.modelPlaceholder
          : loadedModels[0].id;
        modelInput.value = account.model;
        markProvidersDirty();
      }
      updateImageSupport();
      modelStatus.textContent = loadedModels.length ? `${loadedModels.length} models available. Image capability is shown beside each model.` : "No models returned; enter one manually.";
    } catch (error) {
      modelStatus.textContent = `Could not load models: ${error.message}`;
    } finally {
      loadButton.disabled = false;
      controls();
    }
  });
  modelWrap.append(modelInput, loadButton);
  const modelControl = document.createElement("div");
  modelControl.append(modelWrap, imageSupport);
  const modelField = field("Model", modelControl);
  modelField.classList.add("modelField");
  grid.append(modelField);
  updateImageSupport();
  editor.append(editorTitle, grid, modelList, modelStatus);
  row.append(header, editor);
  return row;
}

function field(labelText, control) {
  const label = document.createElement("label");
  label.className = "providerField";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(span, control);
  return label;
}

function checkboxField(labelText, checked, onChange) {
  const label = document.createElement("label");
  label.className = "checkboxField";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(input, span);
  return label;
}

function textInput(value, placeholder, onInput, type = "text") {
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener("input", () => onInput(input.value.trim()));
  return input;
}

function iconButton(text, title, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary iconButton";
  button.textContent = text;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function moveProvider(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= providers.length) return;
  [providers[index], providers[target]] = [providers[target], providers[index]];
  providersDirty = true;
  renderProviders();
  showProviderStatus("Fallback order changed. Save when ready.");
}

function removeProvider(index) {
  providers.splice(index, 1);
  providersDirty = true;
  renderProviders();
  showProviderStatus("Provider removed. Save when ready.");
}

async function saveProviders() {
  try {
    const normalized = normalizeProviderAccounts(providers);
    for (const account of normalized.filter((item) => item.enabled)) validateProviderAccount(account);
    providers = normalized;
    await browser.storage.local.set({ [PROVIDERS_KEY]: providers });
    providersDirty = false;
    renderProviders();
    showProviderStatus(`Saved ${providers.length} provider${providers.length === 1 ? "" : "s"}.`);
  } catch (error) {
    showProviderStatus(`Not saved: ${error.message} Disable unfinished providers or complete their settings.`);
  }
}

function markProvidersDirty() {
  providersDirty = true;
  showProviderStatus("Unsaved changes. Save providers before running AI autofill.");
  controls();
}

async function saveDomainSetting() {
  if (!activeDomain) return;
  const desired = elements.enabled.checked;
  try {
    const stored = await browser.storage.local.get(DOMAINS_KEY);
    const domains = stored[DOMAINS_KEY] || {};
    if (desired) domains[activeDomain] = true;
    else delete domains[activeDomain];
    await browser.storage.local.set({ [DOMAINS_KEY]: domains });
    if (desired) await readQuestions();
    else {
      setQuestions([]);
      showStatus("AI autofill is disabled for this domain.");
    }
  } catch (error) {
    elements.enabled.checked = !desired;
    showStatus(`Could not save the domain setting: ${error.message}`);
  }
  controls();
}

async function readQuestions() {
  if (!activeTab || busy || !elements.enabled.checked) return;
  busy = true;
  controls();
  showStatus("Reading Moodle questions…");
  try {
    const response = await browser.tabs.sendMessage(activeTab.id, { type: "OEB_AI_EXTRACT" });
    if (!response?.ok) throw new Error(response?.error || "The page did not respond.");
    setQuestions(response.questions);
    showStatus(questions.length
      ? `${questions.length} question${questions.length === 1 ? "" : "s"} found.`
      : "No Moodle questions were found on this page.");
  } catch (error) {
    setQuestions([]);
    showStatus(`Could not read the page: ${friendlyContentError(error)}`);
  } finally {
    busy = false;
    controls();
  }
}

async function runAssistant() {
  if (!activeTab || busy) return;
  busy = true;
  controls();
  elements.results.textContent = "Trying the first configured provider…";
  showStatus("Asking AI providers. You may close the popup; the background page will continue.");
  try {
    await noteSaveQueue;
    const run = await browser.runtime.sendMessage({ type: "OEB_AI_RUN", tabId: activeTab.id });
    if (run?.error) throw Object.assign(new Error(run.error), { run });
    elements.results.textContent = JSON.stringify({
      provider: run.provider,
      previousFailures: run.attempts || [],
      answers: run.answers || [],
      results: run.results || []
    }, null, 2);
    showStatus(run.message || "AI autofill finished.");
  } catch (error) {
    elements.results.textContent = JSON.stringify({
      error: error.message,
      attempts: error.run?.attempts || []
    }, null, 2);
    showStatus(`AI autofill failed: ${error.message}`);
  } finally {
    busy = false;
    controls();
  }
}

async function copyQuestions() {
  try {
    await navigator.clipboard.writeText(elements.questions.textContent);
    showStatus("Question JSON copied.");
  } catch (error) {
    showStatus(`Copy failed: ${error.message}`);
  }
}

function shortcutFromEvent(event) {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return "";
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  let key = event.key === " " ? "Space" : event.key;
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

function captureNextShortcut(event) {
  event.preventDefault();
  event.stopPropagation();
  const shortcut = shortcutFromEvent(event);
  if (!shortcut) {
    elements.nextShortcutStatus.textContent = "Keep holding the modifier, then press a letter or other key.";
    return;
  }
  if (!event.ctrlKey && !event.altKey && !event.metaKey) {
    elements.nextShortcutStatus.textContent = "Include Ctrl, Alt, or Meta so normal typing is not intercepted.";
    return;
  }
  saveNextShortcut(shortcut);
}

async function saveNextShortcut(shortcut) {
  try {
    await browser.storage.local.set({[NEXT_SHORTCUT_KEY]: shortcut});
    elements.nextShortcut.value = shortcut;
    elements.nextShortcutStatus.textContent = `Saved. Press ${shortcut} on a Moodle quiz page to continue.`;
  } catch (error) {
    elements.nextShortcutStatus.textContent = `Could not save shortcut: ${error.message}`;
  }
}

function friendlyContentError(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(error.message)
    ? "Reload this tab once so OEB can connect to it."
    : error.message;
}

async function initialize() {
  showView(localStorage.getItem("oebPopupView") === "assistant" ? "assistant" : "seb");
  const stored = await browser.storage.local.get([PROVIDERS_KEY, DOMAINS_KEY, LAST_RUN_KEY, NEXT_SHORTCUT_KEY, NOTE_KEY]);
  elements.note.value = typeof stored[NOTE_KEY] === "string" ? stored[NOTE_KEY] : "";
  elements.nextShortcut.value = stored[NEXT_SHORTCUT_KEY] || DEFAULT_NEXT_SHORTCUT;
  providers = normalizeProviderAccounts(stored[PROVIDERS_KEY]);
  renderProviders();

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url);
    if (!tab?.id || !["http:", "https:"].includes(url.protocol)) throw new Error("Open a normal HTTP or HTTPS page first.");
    activeTab = tab;
    activeDomain = url.hostname.toLowerCase();
    elements.domain.textContent = activeDomain;
    elements.enabled.checked = stored[DOMAINS_KEY]?.[activeDomain] === true;
    elements.enabled.disabled = false;

    const lastRun = stored[LAST_RUN_KEY];
    if (lastRun?.tabId === tab.id && lastRun.url === tab.url) {
      elements.results.textContent = lastRun.error || JSON.stringify({
        provider: lastRun.provider,
        previousFailures: lastRun.attempts || [],
        answers: lastRun.answers || [],
        results: lastRun.results || []
      }, null, 2);
      showStatus(lastRun.message);
    } else if (elements.enabled.checked) {
      await readQuestions();
    } else {
      showStatus("Enable AI autofill for this domain to read questions.");
    }
  } catch (error) {
    elements.domain.textContent = "No supported page open";
    showStatus(error.message);
  }
  controls();
}

initialize().catch((error) => showStatus(`Could not initialize AI autofill: ${error.message}`));
