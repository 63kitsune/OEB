// A bounded, read-only probe for downloads whose URL and headers do not identify SEB.
// Failure always leaves the original download alone. No file data leaves the browser.
const MAX_BYTES = 8 * 1024 * 1024;
const PREFIX_BYTES = 64 * 1024;
const decoder = new TextDecoder();

export function shouldProbeDownload(details) {
  if (details.tabId < 0 || details.statusCode !== 200 || details.method !== "GET") return false;
  if (!/^https?:\/\//i.test(details.url)) return false;
  const headers = Object.fromEntries((details.responseHeaders || []).map(h => [h.name.toLowerCase(), h.value || ""]));
  return /^attachment\b/i.test(headers["content-disposition"] || "")
    || (["main_frame", "sub_frame"].includes(details.type)
      && /^(?:application\/(?:octet-stream|xml|gzip|x-gzip)|text\/xml)(?:;|$)/i.test(headers["content-type"] || ""));
}

function candidate(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  const text = decoder.decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, "").trimStart();
  return /^(?:plnd|pswd|pwcc|pkhs|phsk)/.test(text) || /^(?:<\?xml|<plist)/.test(text);
}

async function readBounded(stream, limit, sniff = false) {
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  let signatureChecked = false;
  let xmlChecked = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) return null;
      parts.push(value);
      // Wait for enough bytes even when the server sends the signature in tiny chunks.
      if (sniff && !signatureChecked && size >= 1024) {
        signatureChecked = true;
        if (!candidate(join(parts, size))) return null;
      }
      if (sniff && !xmlChecked && size >= PREFIX_BYTES) {
        xmlChecked = true;
        const prefix = join(parts, size);
        if (!(prefix[0] === 0x1f && prefix[1] === 0x8b)
          && !/^(?:plnd|pswd|pwcc|pkhs|phsk)/.test(decoder.decode(prefix.subarray(0, 4)))) {
          // Unidentified XML is not an exam configuration.
          if (!isSebXml(prefix)) return null;
        }
      }
    }
    return join(parts, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function join(parts, size) {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function isSebXml(bytes) {
  const text = decoder.decode(bytes);
  return /<plist\b/.test(text) && /<key>\s*(?:startURL|sebConfigPurpose|examKeySalt)\s*<\/key>/.test(text);
}

export async function containsSebConfiguration(input) {
  let bytes = input;
  for (let layer = 0; bytes[0] === 0x1f && bytes[1] === 0x8b; layer++) {
    if (layer >= 4) return false;
    bytes = await readBounded(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), MAX_BYTES);
    if (!bytes) return false;
  }
  return /^(?:plnd|pswd|pwcc|pkhs|phsk)/.test(decoder.decode(bytes.subarray(0, 4))) || isSebXml(bytes);
}

export async function probeSebDownload(url, { fetchImpl = fetch, signal = AbortSignal.timeout(3000) } = {}) {
  try {
    const response = await fetchImpl(url, { credentials: "include", redirect: "follow", cache: "no-store", signal });
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); return null; }
    const bytes = await readBounded(response.body, MAX_BYTES, true);
    return bytes && await containsSebConfiguration(bytes) ? bytes : null;
  } catch {
    return null;
  }
}
