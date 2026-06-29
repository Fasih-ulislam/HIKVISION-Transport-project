// utils/orchestrator.js
//
// Fans a single incoming request out across N devices, running each
// device's full flow in isolation via Promise.allSettled. One device's
// throw/rejection can never affect another's result.
//
// The decrypted password only exists in memory for the lifetime of this
// function call — it's read from Mongo, decrypted, handed into the device
// context, used, and then the context object falls out of scope.

const HikDevice = require("../models/HikDevice");
const { decryptPassword } = require("./crypto");

/**
 * Loads devices to target for this request.
 * @param {object} [filter] - optional Mongo filter, defaults to active-only
 */
async function loadDevices(filter = { status: "active" }) {
  return HikDevice.find(filter).lean();
}

/**
 * Builds a decrypted device context from a Mongo device doc.
 * Throws if decryption fails (wrong key / tampered ciphertext) — caller
 * must catch this per-device, not let it escape and abort the whole batch.
 */
function buildDeviceContext(deviceDoc) {
  const password = decryptPassword(deviceDoc.passwordEnc);
  return {
    deviceId: String(deviceDoc._id),
    ip: deviceDoc.ip,
    username: deviceDoc.username,
    password,
  };
}

/**
 * Runs `fn(deviceContext, req)` against every targeted device, fully isolated.
 *
 * @param {Function} fn - per-device controller fn, e.g. userController.register
 * @param {object} req - the original Express req, passed through unchanged
 * @param {object} [options]
 * @param {object} [options.filter] - Mongo filter to select devices (default: active only)
 * @returns {Promise<{ summary: object, results: Array }>}
 */
async function runAcrossDevices(fn, req, options = {}) {
  const devices = await loadDevices(options.filter);

  if (devices.length === 0) {
    return {
      summary: { total: 0, succeeded: 0, failed: 0 },
      results: [],
    };
  }

  const settled = await Promise.allSettled(
    devices.map(async (deviceDoc) => {
      const base = {
        deviceId: String(deviceDoc._id),
        ip: deviceDoc.ip,
        name: deviceDoc.name || null,
      };

      let deviceContext;
      try {
        deviceContext = buildDeviceContext(deviceDoc);
      } catch (err) {
        // Decryption failure for one device must not abort the others.
        return {
          ...base,
          status: "failed",
          error: "Failed to decrypt stored credentials",
        };
      }

      try {
        const result = await fn(deviceContext, req);
        return {
          ...base,
          status: result?.success ? "success" : "failed",
          data: result?.success ? result : undefined,
          error: result?.success ? undefined : describeError(result),
        };
      } catch (err) {
        // Any unexpected throw inside the per-device flow lands here,
        // scoped to this device only — Promise.allSettled means it never
        // propagates and aborts the other devices' promises.
        return {
          ...base,
          status: "failed",
          error: err?.message || "Unexpected error",
        };
      }
    }),
  );

  // Every entry above already resolves (we catch internally), so
  // Promise.allSettled items will all be "fulfilled" — but we still guard
  // the "rejected" case defensively in case fn() ever throws synchronously
  // in a way that escapes the inner try/catch.
  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          deviceId: String(devices[i]._id),
          ip: devices[i].ip,
          name: devices[i].name || null,
          status: "failed",
          error: s.reason?.message || "Unexpected error",
        },
  );

  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.length - succeeded;

  return {
    summary: { total: results.length, succeeded, failed },
    results,
  };
}

/**
 * Pulls a safe, displayable error string out of a controller result object —
 * never the raw error if it might contain device credentials.
 */
function describeError(result) {
  if (!result) return "Unknown error";
  if (typeof result.error === "string") return result.error;
  if (result.detail) return JSON.stringify(result.detail);
  return result.error ? JSON.stringify(result.error) : "Unknown error";
}

module.exports = {
  runAcrossDevices,
  loadDevices,
  buildDeviceContext,
};
