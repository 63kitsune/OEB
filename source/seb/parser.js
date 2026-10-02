const PREFIX_LENGTH = 4;
const RNC_HEADER_LENGTH = 2;
const SALT_LENGTH = 8;
const IV_LENGTH = 16;
const HMAC_LENGTH = 32;
const PBKDF2_ITERATIONS = 10_000;

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

export class SebParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SebParseError";
    this.code = code;
  }
}

export function decodeEmbeddedSebUrl(value) {
  if (typeof value !== "string") return;
  const match = value.match(/^(?:(?:sebs?):\/\/|data:)application\/seb(?:;[^,]*)?;base64,(.+)$/is);
  if (!match) return;

  try {
    const decoded = decodeURIComponent(match[1])
      .replace(/\s/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = decoded.padEnd(Math.ceil(decoded.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new SebParseError("INVALID_DATA_URL", "The embedded SEB configuration is not valid base64 data.");
  }
}

export async function inspectSebFile(input, password) {
  let data = toBytes(input);
  data = await unwrapGzip(data);

  if (looksLikeXml(data)) {
    return readyResult(data, "xml");
  }

  const prefix = ascii(data.subarray(0, PREFIX_LENGTH));
  const payload = data.subarray(PREFIX_LENGTH);

  switch (prefix) {
    case "plnd":
      return readyResult(await unwrapPlainPayload(payload), prefix);
    case "pswd":
    case "pwcc": {
      if (password === undefined) {
        return {
          status: "password-needed",
          mode: prefix,
          message: prefix === "pwcc"
            ? "This configuring-client SEB file requires its administrator password."
            : "This SEB file requires a password."
        };
      }

      const effectivePassword = prefix === "pwcc"
        ? await sha256Hex(password, true)
        : password;
      const decrypted = await decryptRNCryptor(payload, effectivePassword);
      return readyResult(await unwrapPlainPayload(decrypted), prefix);
    }
    case "pkhs":
    case "phsk":
      throw new SebParseError(
        "CERTIFICATE_REQUIRED",
        "This SEB file is certificate-encrypted. It can only be opened with the matching private certificate."
      );
    default:
      throw new SebParseError(
        "INVALID_SEB",
        "The downloaded data is not a supported SEB XML configuration."
      );
  }
}

async function unwrapPlainPayload(input) {
  let data = await unwrapGzip(input);

  // Some producers include another explicit plain-data block after decryption.
  if (ascii(data.subarray(0, PREFIX_LENGTH)) === "plnd") {
    data = await unwrapGzip(data.subarray(PREFIX_LENGTH));
  }

  if (!looksLikeXml(data)) {
    if (ascii(data.subarray(0, 6)) === "bplist") {
      throw new SebParseError(
        "BINARY_PLIST_UNSUPPORTED",
        "The configuration contains an Apple binary plist instead of XML."
      );
    }
    throw new SebParseError(
      "INVALID_XML",
      "The SEB payload was decoded, but it does not contain an XML property list."
    );
  }

  return data;
}

async function unwrapGzip(input) {
  let data = toBytes(input);
  let layers = 0;

  while (isGzip(data)) {
    if (layers++ >= 4) {
      throw new SebParseError("TOO_MANY_LAYERS", "The SEB file has too many gzip layers.");
    }

    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      throw new SebParseError("INVALID_GZIP", `Could not decompress the SEB data: ${error.message}`);
    }
  }

  return data;
}

async function decryptRNCryptor(data, password) {
  const minimumLength = RNC_HEADER_LENGTH + (2 * SALT_LENGTH) + IV_LENGTH + 16 + HMAC_LENGTH;
  if (data.length < minimumLength) {
    throw new SebParseError("INVALID_ENCRYPTED_DATA", "The encrypted SEB payload is incomplete.");
  }

  const version = data[0];
  const options = data[1];
  if ((version !== 2 && version !== 3) || (options & 1) !== 1) {
    throw new SebParseError(
      "UNSUPPORTED_ENCRYPTION",
      `Unsupported SEB encryption header (version ${version}, options ${options}).`
    );
  }

  const encryptionSalt = data.subarray(2, 10);
  const authenticationSalt = data.subarray(10, 18);
  const iv = data.subarray(18, 34);
  const signedData = data.subarray(0, data.length - HMAC_LENGTH);
  const encryptedData = data.subarray(34, data.length - HMAC_LENGTH);
  const expectedHmac = data.subarray(data.length - HMAC_LENGTH);

  const [encryptionKeyBytes, authenticationKeyBytes] = await Promise.all([
    deriveKey(password, encryptionSalt),
    deriveKey(password, authenticationSalt)
  ]);

  const authenticationKey = await crypto.subtle.importKey(
    "raw",
    authenticationKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    authenticationKey,
    expectedHmac,
    signedData
  );

  if (!valid) {
    throw new SebParseError("INVALID_PASSWORD", "Incorrect password or damaged SEB file.");
  }

  try {
    const encryptionKey = await crypto.subtle.importKey(
      "raw",
      encryptionKeyBytes,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      encryptionKey,
      encryptedData
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new SebParseError("INVALID_PASSWORD", "Incorrect password or damaged SEB file.");
  }
}

async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-1",
      salt,
      iterations: PBKDF2_ITERATIONS
    },
    material,
    256
  );
  return new Uint8Array(bits);
}

async function sha256Hex(value, uppercase = false) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return uppercase ? hex.toUpperCase() : hex;
}

function readyResult(data, mode) {
  const xml = textDecoder.decode(data).replace(/^\uFEFF/, "").trim();
  return { status: "ready", mode, xml };
}

function looksLikeXml(data) {
  const sample = textDecoder.decode(data.subarray(0, Math.min(data.length, 1024)))
    .replace(/^\uFEFF/, "")
    .trimStart();
  return sample.startsWith("<?xml") || sample.startsWith("<plist");
}

function isGzip(data) {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

function ascii(data) {
  return String.fromCharCode(...data);
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return new Uint8Array(input);
  throw new TypeError("Expected SEB data as bytes.");
}
