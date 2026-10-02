const textEncoder = new TextEncoder();
const EMPTY_COLLECTION = Symbol("empty plist collection");
const primaryCollator = new Intl.Collator("en", { sensitivity: "base", usage: "sort", numeric: false });
const tieBreakCollator = new Intl.Collator("en", { sensitivity: "variant", usage: "sort", numeric: false });

export async function calculateSebConfigHash(xml) {
  const root = parsePlist(xml);
  if (!isDictionary(root)) throw new Error("The SEB plist root must be a dictionary.");
  delete root.originatorVersion;
  return sha256Hex(serializeSebJson(root));
}

export async function calculateRequestConfigKey(url, configHash) {
  return sha256Hex(url + configHash);
}

export function calculateRequestConfigKeySync(url, configHash) {
  return sha256HexSync(url + configHash);
}

export function getSebStartUrl(xml) {
  const root = parsePlist(xml);
  if (!isDictionary(root)) throw new Error("The SEB plist root must be a dictionary.");
  return typeof root.startURL === "string" ? root.startURL : undefined;
}

export function getSebQuitSettings(xml) {
  const root = parsePlist(xml);
  if (!isDictionary(root)) throw new Error("The SEB plist root must be a dictionary.");
  const passwordHash = typeof root.hashedQuitPassword === "string"
    ? root.hashedQuitPassword.trim().toLowerCase()
    : "";
  return {
    allowQuit: root.allowQuit !== false,
    passwordRequired: passwordHash.length > 0,
    passwordHash
  };
}

export function getSebPresentationSettings(xml) {
  const root = parsePlist(xml);
  if (!isDictionary(root)) throw new Error("The SEB plist root must be a dictionary.");
  const configuredHeight = Number.isFinite(root.taskBarHeight) ? root.taskBarHeight : 40;
  return {
    taskbar: {
      visible: root.showTaskBar !== false,
      height: Math.max(32, Math.min(80, Math.round(configuredHeight))),
      showClock: root.showTime !== false,
      showKeyboard: root.showInputLanguage !== false,
      showNetwork: root.allowWlan === true,
      showAudio: root.audioControlEnabled === true,
      showReload: root.showReloadButton === true && root.browserWindowAllowReload !== false,
      reloadWarning: root.showReloadWarning !== false,
      showQuit: root.allowQuit !== false && root.showQuitButton !== false
    }
  };
}

export async function verifySebQuitPassword(xml, password) {
  const settings = getSebQuitSettings(xml);
  if (!settings.passwordRequired) return true;
  return (await sha256Hex(password || "")).toLowerCase() === settings.passwordHash;
}

export function serializeSebConfiguration(xml) {
  const root = parsePlist(xml);
  if (!isDictionary(root)) throw new Error("The SEB plist root must be a dictionary.");
  delete root.originatorVersion;
  return serializeSebJson(root);
}

function parsePlist(xml) {
  if (typeof xml !== "string") throw new TypeError("Expected plist XML as text.");
  const tokens = tokenize(xml.replace(/^\uFEFF/, ""));
  let position = 0;

  function peek() {
    while (position < tokens.length && isIgnorable(tokens[position])) position += 1;
    return tokens[position];
  }

  function take() {
    const token = peek();
    position += 1;
    return token;
  }

  function parseValue() {
    const opening = take();
    const open = parseTag(opening);
    if (!open || open.closing) throw new Error(`Invalid plist value near ${opening || "end of file"}.`);

    if (open.name === "true" || open.name === "false") {
      if (!open.selfClosing) expectClosing(open.name);
      return open.name === "true";
    }

    if (open.name === "dict") {
      if (open.selfClosing) return EMPTY_COLLECTION;
      const dictionary = {};
      while (!isClosing(peek(), "dict")) {
        const keyOpening = take();
        const keyTag = parseTag(keyOpening);
        if (!keyTag || keyTag.name !== "key" || keyTag.closing) {
          throw new Error("A plist dictionary entry is missing its key.");
        }
        const key = keyTag.selfClosing ? "" : readTextUntilClosing("key");
        const value = parseValue();
        if (value !== EMPTY_COLLECTION) dictionary[key] = value;
      }
      take();
      return Object.keys(dictionary).length === 0 ? EMPTY_COLLECTION : dictionary;
    }

    if (open.name === "array") {
      if (open.selfClosing) return [];
      const values = [];
      while (!isClosing(peek(), "array")) {
        const value = parseValue();
        if (value !== EMPTY_COLLECTION) values.push(value);
      }
      take();
      return values;
    }

    const raw = open.selfClosing ? "" : readTextUntilClosing(open.name);
    switch (open.name) {
      case "string":
        return raw;
      case "data":
        return raw.replace(/\s/g, "");
      case "date":
        return normalizeDate(raw);
      case "integer": {
        const value = Number.parseInt(raw.trim() || "0", 10);
        if (!Number.isFinite(value)) throw new Error(`Invalid plist integer: ${raw}`);
        return value;
      }
      case "real": {
        const value = Number.parseFloat(raw.trim() || "0");
        if (!Number.isFinite(value)) throw new Error(`Invalid plist real: ${raw}`);
        return value;
      }
      default:
        throw new Error(`Unsupported plist element <${open.name}>.`);
    }
  }

  function readTextUntilClosing(name) {
    let value = "";
    while (position < tokens.length && !isClosing(peek(), name)) {
      const token = take();
      if (token.startsWith("<![CDATA[")) value += token.slice(9, -3);
      else if (!token.startsWith("<")) value += decodeXmlEntities(token);
      else throw new Error(`Unexpected element inside <${name}>.`);
    }
    expectClosing(name);
    return value;
  }

  function expectClosing(name) {
    const closing = take();
    if (!isClosing(closing, name)) throw new Error(`Missing closing </${name}> element.`);
  }

  const plistOpening = take();
  const plistTag = parseTag(plistOpening);
  if (!plistTag || plistTag.name !== "plist" || plistTag.closing) {
    throw new Error("The file is not an XML plist.");
  }
  const root = parseValue();
  expectClosing("plist");
  return root === EMPTY_COLLECTION ? {} : root;
}

function tokenize(xml) {
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z][^>]*>|[^<]+/gi;
  return xml.match(pattern) || [];
}

function isIgnorable(token = "") {
  return /^\s*$/.test(token) || token.startsWith("<?") || token.startsWith("<!--") || /^<!DOCTYPE/i.test(token);
}

function parseTag(token = "") {
  const match = token.match(/^<\s*(\/)?\s*([A-Za-z][\w:-]*)[^>]*>$/);
  if (!match) return;
  return {
    closing: Boolean(match[1]),
    name: match[2].toLowerCase(),
    selfClosing: /\/\s*>$/.test(token)
  };
}

function isClosing(token, name) {
  const tag = parseTag(token);
  return Boolean(tag?.closing && tag.name === name);
}

function decodeXmlEntities(value) {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|lt|gt|amp|quot|apos);/gi, (entity, decimal, hexadecimal) => {
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    return { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" }[entity.toLowerCase()];
  });
}

function normalizeDate(value) {
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) return value.trim();
  return date.toISOString().replace(/\.000Z$/, "+00:00");
}

function serializeSebJson(value) {
  if (Array.isArray(value)) return `[${value.map(serializeSebJson).join(",")}]`;
  if (isDictionary(value)) {
    const keys = Object.keys(value).sort(compareKeys);
    return `{${keys.map((key) => `"${key}":${serializeSebJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return '""';
}

function compareKeys(left, right) {
  return primaryCollator.compare(left, right) || tieBreakCollator.compare(left, right);
}

function isDictionary(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256HexSync(value) {
  const bytes = textEncoder.encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const bitLength = BigInt(bytes.length) * 8n;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn));
  paddedView.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));

  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = paddedView.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}
