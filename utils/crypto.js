// utils/crypto.js
//
// AES-256-GCM encryption for device credentials at rest.
// Key comes from process.env.DEVICE_CRED_KEY — a 64-char hex string (32 bytes).
//
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// GCM gives authenticated encryption: tampering with the ciphertext or authTag
// causes decryption to throw, instead of silently returning garbage.

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV is the recommended size for GCM

function getKey() {
  const keyHex = process.env.DEVICE_CRED_KEY;
  if (!keyHex) {
    throw new Error("DEVICE_CRED_KEY is not set in environment");
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error(
      `DEVICE_CRED_KEY must decode to 32 bytes, got ${key.length}. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return key;
}

/**
 * Encrypts a plaintext password.
 * @param {string} plainText
 * @returns {{ ciphertext: string, iv: string, authTag: string }} all hex-encoded
 */
function encryptPassword(plainText) {
  if (typeof plainText !== "string" || plainText.length === 0) {
    throw new Error("encryptPassword: plainText must be a non-empty string");
  }

  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH); // unique per encryption, never reused

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/**
 * Decrypts a credential object back to plaintext.
 * Throws if the key is wrong or the data has been tampered with.
 * @param {{ ciphertext: string, iv: string, authTag: string }} encObj
 * @returns {string} plaintext password
 */
function decryptPassword(encObj) {
  if (!encObj || !encObj.ciphertext || !encObj.iv || !encObj.authTag) {
    throw new Error(
      "decryptPassword: expected { ciphertext, iv, authTag } object",
    );
  }

  const key = getKey();
  const iv = Buffer.from(encObj.iv, "hex");
  const authTag = Buffer.from(encObj.authTag, "hex");
  const ciphertext = Buffer.from(encObj.ciphertext, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(), // throws here if authTag doesn't match (tampered/wrong key)
  ]);

  return decrypted.toString("utf8");
}

module.exports = {
  encryptPassword,
  decryptPassword,
};
