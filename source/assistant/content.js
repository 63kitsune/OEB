// Bridges the background workflow to the isolated page-side extraction/apply modules.
if (window === window.top) {
  const NEXT_SHORTCUT_KEY = "oebNextPageShortcut";
  const DEFAULT_NEXT_SHORTCUT = "Ctrl+Shift+X";
  let nextPageShortcut = DEFAULT_NEXT_SHORTCUT;

  browser.storage.local.get(NEXT_SHORTCUT_KEY).then((stored) => {
    nextPageShortcut = stored[NEXT_SHORTCUT_KEY] || DEFAULT_NEXT_SHORTCUT;
  }).catch(() => {});

  browser.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && changes[NEXT_SHORTCUT_KEY]) {
      nextPageShortcut = changes[NEXT_SHORTCUT_KEY].newValue || DEFAULT_NEXT_SHORTCUT;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.repeat || shortcutFromEvent(event) !== nextPageShortcut) return;
    const next = document.querySelector('#mod_quiz-next-nav, input.mod_quiz-next-nav[name="next"], button.mod_quiz-next-nav[name="next"]');
    if (!next || next.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    next.click();
  }, true);

  browser.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type === "OEB_AI_EXTRACT") {
      globalThis.OEBAssistant.extractQuestions()
        .then((questions) => sendResponse({ ok: true, questions }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (request?.type === "OEB_AI_APPLY") {
      globalThis.OEBAssistant.applyAnswers(request.answers || [])
        .then((results) => sendResponse({ ok: true, results }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    return false;
  });

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
}
