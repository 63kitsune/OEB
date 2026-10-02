const SEB_SCHEME = /^(?:sebs?):\/\//i;
const SEB_FILE = /(?:^|[/?=&])[^/?=&]*\.seb(?:$|[?#&])/i;
const STARTUP_FRAME_ID = "seb-local-startup-frame";
const TASKBAR_FRAME_ID = "seb-local-taskbar-frame";
const QUIT_FRAME_ID = "seb-local-quit-frame";
const IS_TOP_FRAME = window === window.top;
let presentationSettings = { showStartupAnimation: true, taskbarMode: "auto", taskbarScale: 100, config: { taskbar: {} } };

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!IS_TOP_FRAME && request?.type?.startsWith("SEB_")) return false;
  switch (request?.type) {
    case "SEB_SHOW_STARTUP":
      showStartup(request.settings || {});
      sendResponse({ ok: true });
      break;
    case "SEB_APPLY_PRESENTATION":
      applyPresentation(request.settings || {});
      sendResponse({ ok: true });
      break;
    case "SEB_UNLOAD_PRESENTATION":
      removePresentation();
      sendResponse({ ok: true });
      break;
    case "SEB_RESET_MOODLE_ACCESS":
      resetMoodleSebAccess(request.cmid).then(sendResponse);
      return true;
    default:
      return false;
  }
  return false;
});

document.addEventListener("click", (event) => {
  if (event.button !== 0 || event.defaultPrevented) return;

  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest("a, button, input[type=button], input[type=submit]");
  if (!control) return;

  const url = findUrl(control);
  if (url && isSebUrl(url)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    sendUrl(url, "detected page control");
  }
}, true);

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  const submitter = event.submitter;
  const action = submitter?.getAttribute("formaction") || form.action;
  if (!isSebUrl(action)) return;

  const formData = new FormData(form, submitter || undefined);
  if (Array.from(formData.values()).some((value) => value instanceof File && value.size > 0)) return;

  const method = (submitter?.getAttribute("formmethod") || form.method || "GET").toUpperCase();
  const params = new URLSearchParams();
  for (const [key, value] of formData) params.append(key, String(value));

  let url = new URL(action, location.href);
  let body;
  if (method === "GET") {
    for (const [key, value] of params) url.searchParams.append(key, value);
  } else if (method === "POST") {
    body = params.toString();
  } else {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  sendUrl(url.href, "detected page form", method, body);
}, true);

function findUrl(control) {
  const candidates = [
    control.href,
    control.dataset?.url,
    control.dataset?.href,
    control.getAttribute?.("data-download-url"),
    control.getAttribute?.("formaction")
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return SEB_SCHEME.test(candidate) ? candidate : new URL(candidate, location.href).href;
    } catch {
      // Try the next candidate.
    }
  }
}

function isSebUrl(url) {
  return SEB_SCHEME.test(url) || SEB_FILE.test(url);
}

function sendUrl(url, source, method = "GET", body) {
  browser.runtime.sendMessage({
    type: "SEB_CAPTURE_URL",
    url,
    source,
    autoLaunch: SEB_SCHEME.test(url),
    method,
    body,
    pageUrl: location.href
  }).catch(() => {
    // The extension may have been reloaded while this page was open.
  });
}

async function initializePresentation() {
  try {
    const response = await browser.runtime.sendMessage({ type: "SEB_GET_PAGE_PRESENTATION" });
    if (!response?.ok || !response.presentation?.loaded) return;

    await whenDocumentLoaded();
    applyPresentation(response.presentation.settings);
    if (response.presentation.afterReload) {
      browser.runtime.sendMessage({ type: "SEB_TRANSITION_FINISHED" }).catch(() => {});
    }
  } catch {
    // The extension may have been reloaded while this document was loading.
  }
}

function showStartup(settings) {
  presentationSettings = { ...presentationSettings, ...settings };
  if (!settings.showStartupAnimation || document.getElementById(STARTUP_FRAME_ID)) return;
  document.getElementById(TASKBAR_FRAME_ID)?.remove();

  const frame = document.createElement("iframe");
  frame.id = STARTUP_FRAME_ID;
  frame.title = "Safe Exam Browser startup";
  frame.src = browser.runtime.getURL("seb/assets/startup.html");
  frame.setAttribute("aria-hidden", "true");
  document.documentElement.append(frame);

  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    window.removeEventListener("message", onMessage);
    browser.runtime.sendMessage({ type: "SEB_STARTUP_FINISHED" }).catch(() => {
      frame.remove();
    });
  };
  const onMessage = (event) => {
    if (event.source === frame.contentWindow && event.data?.type === "SEB_STARTUP_COMPLETE") finish();
  };
  window.addEventListener("message", onMessage);
}

function applyPresentation(settings) {
  presentationSettings = { ...presentationSettings, ...settings };
  const taskbar = presentationSettings.config?.taskbar || {};
  const visible = presentationSettings.taskbarMode === "show" ||
    (presentationSettings.taskbarMode !== "hide" && taskbar.visible !== false);
  if (visible) showSebBar(taskbar, presentationSettings.taskbarScale);
  else document.getElementById(TASKBAR_FRAME_ID)?.remove();
}

function showSebBar(taskbar = {}, configuredScale = 100) {
  let frame = document.getElementById(TASKBAR_FRAME_ID);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = TASKBAR_FRAME_ID;
    frame.title = "Safe Exam Browser taskbar";
    document.documentElement.append(frame);
  }
  const baseHeight = Math.max(32, Math.min(80, Number(taskbar.height) || 40));
  const scale = Math.max(50, Math.min(300, Number(configuredScale) || 100));
  const height = Math.max(20, Math.min(240, Math.round(baseHeight * scale / 100)));
  const query = new URLSearchParams({
    height: String(height),
    clock: taskbar.showClock === false ? "0" : "1",
    keyboard: taskbar.showKeyboard === false ? "0" : "1",
    network: taskbar.showNetwork ? "1" : "0",
    audio: taskbar.showAudio ? "1" : "0",
    reload: taskbar.showReload ? "1" : "0",
    reloadWarning: taskbar.reloadWarning === false ? "0" : "1",
    quit: taskbar.showQuit === false ? "0" : "1"
  });
  const desired = browser.runtime.getURL(`seb/assets/taskbar.html?${query}`);
  if (frame.src !== desired) frame.src = desired;
  frame.style.setProperty("height", `${height}px`, "important");
}

function removePresentation() {
  document.getElementById(STARTUP_FRAME_ID)?.remove();
  document.getElementById(TASKBAR_FRAME_ID)?.remove();
  document.getElementById(QUIT_FRAME_ID)?.remove();
}

async function openQuitDialog() {
  if (document.getElementById(QUIT_FRAME_ID)) return;
  const response = await browser.runtime.sendMessage({ type: "SEB_GET_QUIT_REQUIREMENTS" });
  if (!response?.ok || !response.allowQuit) return;

  const frame = document.createElement("iframe");
  frame.id = QUIT_FRAME_ID;
  frame.title = "Quit Safe Exam Browser";
  const query = new URLSearchParams({
    password: response.passwordRequired ? "1" : "0",
    disabled: "0"
  });
  frame.src = browser.runtime.getURL(`seb/assets/quit.html?${query}`);
  document.documentElement.append(frame);
}

async function handlePresentationMessage(event) {
  const taskbar = document.getElementById(TASKBAR_FRAME_ID);
  const quitFrame = document.getElementById(QUIT_FRAME_ID);
  if (taskbar && event.source === taskbar.contentWindow && event.data?.type === "SEB_QUIT_REQUEST") {
    await openQuitDialog();
    return;
  }
  if (taskbar && event.source === taskbar.contentWindow && event.data?.type === "SEB_RELOAD_REQUEST") {
    if (!event.data.warning || confirm("Would you like to reload the current page?")) location.reload();
    return;
  }
  if (taskbar && event.source === taskbar.contentWindow && event.data?.type === "SEB_AUDIO_TOGGLE") {
    const media = [...document.querySelectorAll("audio, video")];
    const muted = media.some(element => !element.muted);
    media.forEach(element => { element.muted = muted; });
    taskbar.contentWindow?.postMessage({ type: "SEB_AUDIO_STATE", muted }, "*");
    return;
  }
  if (!quitFrame || event.source !== quitFrame.contentWindow) return;
  if (event.data?.type === "SEB_QUIT_CANCEL") {
    quitFrame.remove();
    return;
  }
  if (event.data?.type === "SEB_QUIT_SUBMIT") {
    const response = await browser.runtime.sendMessage({
      type: "SEB_QUIT",
      confirmed: true,
      password: event.data.password || ""
    });
    if (!response?.ok) {
      quitFrame.contentWindow?.postMessage({ type: "SEB_QUIT_ERROR", error: response?.error || "Could not quit." }, "*");
    }
  }
}

async function resetMoodleSebAccess(cmid) {
  try {
    const logoutLink = document.querySelector('a[href*="/login/logout.php"][href*="sesskey="]');
    const inputKey = document.querySelector('input[name="sesskey"]')?.value;
    const linkedKey = logoutLink ? new URL(logoutLink.href).searchParams.get("sesskey") : undefined;
    const markupKey = document.documentElement.innerHTML.match(/"sesskey"\s*:\s*"([A-Za-z0-9]+)"/)?.[1];
    const sesskey = inputKey || linkedKey || markupKey;
    if (!sesskey || !cmid) return { ok: false, error: "Could not find the Moodle session key." };

    const body = new URLSearchParams({ sesskey, cmid: String(cmid) });
    const response = await fetch("/mod/quiz/accessrule/seb/clear_session.php", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body
    });
    return response.ok ? { ok: true } : { ok: false, error: `Moodle reset failed with HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function whenDocumentLoaded() {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
}

if (IS_TOP_FRAME) {
  window.addEventListener("message", handlePresentationMessage);
  initializePresentation();
}
