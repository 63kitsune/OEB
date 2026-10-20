// Bridge page-owned Blob bytes to the extension; the background validates every candidate.
(() => {
  const CHANNEL = "oeb-download-capture-v1";
  let enabled = true;
  const announce = () => window.postMessage({ channel: CHANNEL, type: "settings", enabled }, "*");
  browser.runtime.sendMessage({ type: "SEB_GET_SETTINGS" }).then(response => {
    enabled = response?.settings?.checkDownloadsForSeb !== false;
    announce();
  }).catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.sebInspectorSettings) {
      enabled = changes.sebInspectorSettings.newValue?.checkDownloadsForSeb !== false;
      announce();
    }
  });
  window.addEventListener("message", async event => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "ready") { announce(); return; }
    if (event.data.type !== "bytes" || typeof event.data.token !== "string") return;
    const { token, bytes, filename, sourceUrl } = event.data;
    let claimed = false;
    if (enabled && Object.prototype.toString.call(bytes) === "[object ArrayBuffer]" && bytes.byteLength <= 8 * 1024 * 1024) {
      try {
        const response = await browser.runtime.sendMessage({ type: "SEB_CHECK_DOWNLOAD_BYTES",
          bytes: Array.from(new Uint8Array(bytes)), filename: String(filename || "download"),
          sourceUrl: String(sourceUrl || ""), pageUrl: location.href });
        claimed = response?.recognized === true && response?.ok === true;
      } catch { /* Let the original download continue. */ }
    }
    window.postMessage({ channel: CHANNEL, type: "result", token, claimed }, "*");
  });
  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.type !== "SEB_PROBE_DOWNLOAD_URL") return false;
    (async () => {
      if (!enabled || !/^https?:\/\//i.test(request.url || "")) return { ok: true };
      try {
        const response = await fetch(request.url, { credentials: "include", signal: AbortSignal.timeout(5000) });
        if (!response.ok || !response.body) return { ok: true };
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8 * 1024 * 1024) return { ok: true };
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        return { ok: true, bytes: Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())) };
      } catch { return { ok: true }; }
    })().then(sendResponse, () => sendResponse({ ok: true }));
    return true;
  });

  // Chrome MV2 cannot declare world: MAIN in the manifest. Load our bundled
  // page hook through the DOM instead; Firefox keeps its native MAIN registration.
  if (!browser.runtime.getBrowserInfo) {
    const inject = () => {
      const script = document.createElement("script");
      script.src = browser.runtime.getURL("seb/download-page.js");
      script.async = false;
      script.addEventListener("load", () => script.remove(), { once: true });
      script.addEventListener("error", () => script.remove(), { once: true });
      (document.head || document.documentElement).appendChild(script);
    };
    if (document.documentElement) inject();
    else {
      const observer = new MutationObserver(() => {
        if (!document.documentElement) return;
        observer.disconnect();
        inject();
      });
      observer.observe(document, { childList: true });
    }
  }
})();
