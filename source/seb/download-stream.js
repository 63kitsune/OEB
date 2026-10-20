// Firefox can inspect the original response, including one-use and POST downloads.
// Pass every byte through unchanged; capture only a bounded copy for validation.
export function mirrorDownloadResponse(filter, onBytes, { limit = 8 * 1024 * 1024 } = {}) {
  let chunks = [];
  let size = 0;
  let overflow = false;
  const finished = new Promise(resolve => {
    filter.ondata = event => {
      filter.write(event.data);
      size += event.data.byteLength;
      if (size > limit) { overflow = true; chunks = []; }
      else if (!overflow) chunks.push(new Uint8Array(event.data).slice());
    };
    filter.onerror = () => { chunks = []; try { filter.disconnect(); } catch {} resolve(false); };
    filter.onstop = async () => {
      try { filter.close(); } catch {}
      if (overflow) { resolve(false); return; }
      try {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        chunks = [];
        resolve(await onBytes(bytes));
      } catch { resolve(false); }
    };
  });
  return finished;
}

export function isExtensionlessResponse(details) {
  if (details.statusCode !== 200 || !/^https?:\/\//i.test(details.url)) return false;
  const headers = Object.fromEntries((details.responseHeaders || []).map(h => [h.name.toLowerCase(), h.value || ""]));
  const disposition = headers['content-disposition'] || '';
  const match = disposition.match(/filename\*?\s*=\s*(?:UTF-8'')?"?([^";]+)/i);
  let filename = match?.[1];
  if (filename) { try { filename = decodeURIComponent(filename); } catch {} }
  const attachment = /^attachment\b/i.test(disposition);
  if (!attachment && !['main_frame', 'sub_frame'].includes(details.type)) return false;
  const name = filename || new URL(details.url).pathname.split('/').pop() || '';
  return !/\.[a-z\d]{1,12}$/i.test(name);
}
