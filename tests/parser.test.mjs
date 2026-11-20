import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { inspectSebFile } from "../source/seb/parser.js";

const xml = '<?xml version="1.0"?><plist><dict><key>startURL</key><string>http://localhost/quiz</string></dict></plist>';

// Independent RNCryptor writer: PBKDF2-SHA1, AES-256-CBC with PKCS#7, HMAC-SHA256.
function encryptedFile(mode, password, { version = 3, plaintext = gzipSync(xml), outerGzip = true } = {}) {
  const encryptionSalt = Buffer.from("0102030405060708", "hex");
  const authenticationSalt = Buffer.from("1112131415161718", "hex");
  const iv = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const effective = mode === "pwcc" && password !== ""
    ? createHash("sha256").update(password).digest("hex").toUpperCase()
    : password;
  const cipher = createCipheriv("aes-256-cbc", pbkdf2Sync(effective, encryptionSalt, 10000, 32, "sha1"), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const signed = Buffer.concat([Buffer.from([version, 1]), encryptionSalt, authenticationSalt, iv, ciphertext]);
  const tag = createHmac("sha256", pbkdf2Sync(effective, authenticationSalt, 10000, 32, "sha1")).update(signed).digest();
  const file = Buffer.concat([Buffer.from(mode), signed, tag]);
  return outerGzip ? gzipSync(file) : file;
}

for (const mode of ["pwcc", "pswd"]) {
  for (const version of [2, 3]) {
    test(`${mode} RNCryptor v${version}: opens an empty password automatically and explicitly`, async () => {
      const file = encryptedFile(mode, "", { version });
      const expected = { status: "ready", mode, xml };
      assert.deepEqual(await inspectSebFile(file), expected);
      assert.deepEqual(await inspectSebFile(file, ""), expected);
    });
  }

  test(`${mode}: prompts for a nonempty password and accepts the correct one`, async () => {
    const file = encryptedFile(mode, "local-test-password");
    assert.equal((await inspectSebFile(file)).status, "password-needed");
    assert.equal((await inspectSebFile(file)).mode, mode);
    assert.deepEqual(await inspectSebFile(file, "local-test-password"), { status: "ready", mode, xml });
    for (const password of ["", "incorrect"]) {
      await assert.rejects(inspectSebFile(file, password), { code: "INVALID_PASSWORD" });
    }
  });

  test(`${mode}: authenticated invalid payloads report the payload error`, async () => {
    await assert.rejects(inspectSebFile(encryptedFile(mode, "", { plaintext: gzipSync("invalid plist") })), { code: "INVALID_XML" });
    await assert.rejects(inspectSebFile(encryptedFile(mode, "", { plaintext: Buffer.from([0x1f, 0x8b, 0]) })), { code: "INVALID_GZIP" });
  });

  test(`${mode}: corrupted authentication never yields a decoded configuration`, async () => {
    const file = encryptedFile(mode, "", { outerGzip: false });
    file[file.length - 1] ^= 1;
    assert.equal((await inspectSebFile(file)).status, "password-needed");
    await assert.rejects(inspectSebFile(file, ""), { code: "INVALID_PASSWORD" });
  });
}

test("invalid encryption headers and truncated files do not become password prompts", async () => {
  await assert.rejects(inspectSebFile(encryptedFile("pwcc", "", { version: 9 })), { code: "UNSUPPORTED_ENCRYPTION" });
  await assert.rejects(inspectSebFile(Buffer.from("pwcc")), { code: "INVALID_ENCRYPTED_DATA" });
});

test("plain XML and plnd configurations still open directly", async () => {
  assert.deepEqual(await inspectSebFile(Buffer.from(xml)), { status: "ready", mode: "xml", xml });
  assert.deepEqual(await inspectSebFile(gzipSync(Buffer.concat([Buffer.from("plnd"), gzipSync(xml)]))), { status: "ready", mode: "plnd", xml });
});
