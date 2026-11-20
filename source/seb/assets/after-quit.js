(async () => {
  const whenVisible = () => document.visibilityState === "visible" ? Promise.resolve()
    : new Promise(resolve => document.addEventListener("visibilitychange", resolve, { once: true }));
  const stored = await browser.storage.local.get(["sebInspectorSettings", "oebQuitScreenshot"]);
  const settings = stored.sebInspectorSettings || {};
  document.documentElement.classList.toggle("show-cursor", settings.showCursorOnBlack !== false);
  document.documentElement.classList.toggle("windows-cursor", settings.windowsCursorAfterQuit === true);
  const delay = new URL(location.href).searchParams.get("blackout") === "done"
    ? 0 : Math.max(0, Math.min(3600, Number(settings.blackoutSeconds) || 0)) * 1000;
  if (settings.afterQuit === "screenshot") {
    const dataUrl = stored.oebQuitScreenshot?.dataUrl;
    if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) return;
    const screen = document.querySelector("#screen");
    screen.src = dataUrl;
    await new Promise(resolve => { if (screen.complete) resolve(); else { screen.onload = resolve; screen.onerror = resolve; } });
    await whenVisible();
    setTimeout(() => document.documentElement.classList.add("revealed"), delay);
  } else if (settings.afterQuit === "custom-page") {
    try {
      const url = new URL(settings.customQuitUrl);
      if (!["http:", "https:"].includes(url.protocol)) return;
      await whenVisible();
      setTimeout(async () => {
        document.documentElement.classList.add("show-cursor");
        if (settings.windowsCursorAfterQuit) {
          await browser.runtime.sendMessage({ type: "SEB_ENABLE_AFTER_QUIT_CURSOR" }).catch(() => {});
        }
        requestAnimationFrame(() => location.replace(url.href));
      }, delay);
    } catch { /* Invalid settings leave the screen black. */ }
  }
})();
