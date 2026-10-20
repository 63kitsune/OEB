// Runs in the page so blob downloads can be read before their URLs are revoked.
(() => {
  const CHANNEL = "oeb-download-capture-v1";
  const MAX_BYTES = 8 * 1024 * 1024;
  const nativeClick = HTMLAnchorElement.prototype.click;
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  const blobs = new Map();
  const pending = new Map();
  let enabled = true;
  let serial = 0;
  const bypass = new WeakSet();

  URL.createObjectURL = function(value) {
    const url = Reflect.apply(createObjectURL, this, arguments);
    if (value instanceof Blob) blobs.set(url, value);
    return url;
  };
  URL.revokeObjectURL = function(url) {
    blobs.delete(String(url));
    return Reflect.apply(revokeObjectURL, this, arguments);
  };

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") enabled = event.data.enabled !== false;
    if (event.data.type === "result") {
      pending.get(event.data.token)?.(event.data.claimed === true);
    }
  });

  function eligible(anchor) {
    if (!enabled || !anchor?.href || (blobs.get(anchor.href)?.size || 0) > MAX_BYTES) return false;
    const name = anchor.getAttribute("download") || "";
    const extensionless = !/\.[a-z\d]{1,12}$/i.test(name.split(/[\\/]/).pop());
    return (anchor.hasAttribute("download") || /^(?:blob:|data:)/i.test(anchor.href))
      && (extensionless || /\.seb$/i.test(name));
  }

  async function inspect(anchor, blob) {
    try {
      const response = blob ? null : await fetch(anchor.href, { credentials: "include", signal: AbortSignal.timeout(5000) });
      if (response && !response.ok) return false;
      if (!blob) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        let checkedPrefix = false;
        try {
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) return false;
            chunks.push(value);
            if (size >= 1024 && !checkedPrefix) {
              checkedPrefix = true;
              if (!looksRelevant(new Uint8Array(await new Blob(chunks).slice(0, 1024).arrayBuffer()))) return false;
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
        blob = new Blob(chunks);
      }
      if (blob.size > MAX_BYTES) return false;
      const bytes = await blob.arrayBuffer();
      if (!looksRelevant(new Uint8Array(bytes))) return false;
      const token = `${Date.now()}-${++serial}`;
      return await new Promise(resolve => {
        const timeout = setTimeout(() => finish(false), 15000);
        const finish = claimed => { clearTimeout(timeout); pending.delete(token); resolve(claimed); };
        pending.set(token, finish);
        window.postMessage({ channel: CHANNEL, type: "bytes", token, bytes,
          filename: anchor.getAttribute("download") || "download", sourceUrl: anchor.href }, "*", [bytes]);
      });
    } catch { return false; }
  }

  function looksRelevant(bytes) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
    const prefix = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, "").trimStart();
    return /^(?:<\?xml|<plist|plnd|pswd|pwcc|pkhs|phsk)/.test(prefix);
  }

  function handle(anchor, original) {
    // Keep a Blob reference now: callers often revoke its URL immediately after click().
    const blob = blobs.get(anchor.href);
    inspect(anchor, blob).then(claimed => {
      if (!claimed) original(blob);
    });
  }

  HTMLAnchorElement.prototype.click = function() {
    if (!eligible(this) || bypass.has(this)) return Reflect.apply(nativeClick, this, arguments);
    const anchor = this;
    handle(anchor, blob => {
      let temporary;
      const href = anchor.href;
      if (blob) { temporary = Reflect.apply(createObjectURL, URL, [blob]); anchor.href = temporary; }
      bypass.add(anchor);
      try { Reflect.apply(nativeClick, anchor, []); }
      finally {
        bypass.delete(anchor);
        if (temporary) { anchor.href = href; setTimeout(() => Reflect.apply(revokeObjectURL, URL, [temporary]), 1000); }
      }
    });
  };

  document.addEventListener("click", event => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (event.defaultPrevented || event.button !== 0 || !eligible(anchor) || bypass.has(anchor)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handle(anchor, blob => {
      let temporary;
      const href = anchor.href;
      if (blob) { temporary = Reflect.apply(createObjectURL, URL, [blob]); anchor.href = temporary; }
      bypass.add(anchor);
      try { Reflect.apply(nativeClick, anchor, []); }
      finally {
        bypass.delete(anchor);
        if (temporary) { anchor.href = href; setTimeout(() => Reflect.apply(revokeObjectURL, URL, [temporary]), 1000); }
      }
    });
  }, true);
  window.postMessage({ channel: CHANNEL, type: "ready" }, "*");
})();
