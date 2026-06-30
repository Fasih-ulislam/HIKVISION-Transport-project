// utils/orchestrator.js
//
// Fans a single incoming request out across N devices, running each
// device's full flow in isolation via Promise.allSettled. One device's
// throw/rejection can never affect another's result.
//
// The decrypted password only exists in memory for the lifetime of this
// function call — it's read from Mongo, decrypted, handed into the device
// context, used, and then the context object falls out of scope.
//
// FILE OWNERSHIP: if the request carries an uploaded file (req.file), this
// orchestrator is the sole owner of its lifecycle. Per-device controller
// fns (register, update, etc.) only ever READ the file path — they must
// never unlink it themselves, since the same file is shared read-only
// across every device's in-flight call. Cleanup happens exactly once,
// here, after every device has settled and right before we return the
// aggregated response.

const fs = require("fs");
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
 * Deletes the request's uploaded file, if any. Safe to call even when
 * there's no file. Swallows ENOENT-type errors since cleanup failing
 * should never affect the response we send back.
 */
function cleanupUploadedFile(req) {
  const file = req.file;
  if (!file) return;
  fs.unlink(file.path, (err) => {
    if (err) {
      console.error(
        `[orchestrator] failed to clean up uploaded file ${file.path}:`,
        err.message,
      );
    }
  });
}

/**
 * Runs `fn(deviceContext, req)` against every targeted device, fully isolated.
 *
 * @param {Function} fn - per-device controller fn, e.g. userController.register
 * @param {object} req - the original Express req, passed through unchanged
 * @param {object} [options]
 * @param {object} [options.filter] - Mongo filter to select devices (default: active only)
 * @param {Function} [options.onDeviceSettled] - optional (deviceDoc, result) => void|Promise<void>,
 *   called once per device immediately after that device's call settles (success or failure),
 *   before the next device's callback runs is NOT guaranteed — callbacks across devices may
 *   interleave/run concurrently, same as the underlying Promise.allSettled. Used by callers
 *   that need a side effect per device (e.g. writing sync-state records) without the
 *   orchestrator itself knowing anything about what that side effect is. Errors thrown from
 *   this callback are caught and logged, never allowed to affect that device's recorded
 *   result or any other device.
 * @returns {Promise<{ summary: object, results: Array }>}
 */
async function runAcrossDevices(fn, req, options = {}) {
  const devices = await loadDevices(options.filter);
  const onDeviceSettled = options.onDeviceSettled;

  if (devices.length === 0) {
    // No devices to run against — still our job to clean up any upload,
    // since the controller fn never got a chance to run at all.
    cleanupUploadedFile(req);
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
      let outcome;

      try {
        deviceContext = buildDeviceContext(deviceDoc);
      } catch (err) {
        // Decryption failure for one device must not abort the others.
        outcome = {
          ...base,
          status: "failed",
          error: "Failed to decrypt stored credentials",
        };
      }

      if (!outcome) {
        try {
          // NOTE: fn must not delete req.file here — it's shared read-only
          // across every device's concurrent call. Cleanup happens once,
          // below, after all devices have settled.
          const result = await fn(deviceContext, req);
          outcome = {
            ...base,
            status: result?.success ? "success" : "failed",
            data: result?.success ? result : undefined,
            error: result?.success ? undefined : describeError(result),
            // Raw controller result preserved for onDeviceSettled callers
            // that need finer detail than the summarized outcome above
            // (e.g. which part of a combined profile+image update failed).
            raw: result,
          };
        } catch (err) {
          // Any unexpected throw inside the per-device flow lands here,
          // scoped to this device only — Promise.allSettled means it never
          // propagates and aborts the other devices' promises.
          outcome = {
            ...base,
            status: "failed",
            error: err?.message || "Unexpected error",
          };
        }
      }

      if (onDeviceSettled) {
        try {
          await onDeviceSettled(deviceDoc, outcome);
        } catch (callbackErr) {
          // A failure recording sync state must never look like a failure
          // of the underlying device operation, and must never affect
          // any other device's callback.
          console.error(
            `[orchestrator] onDeviceSettled callback failed for device ${base.deviceId}:`,
            callbackErr.message,
          );
        }
      }

      return outcome;
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

  // All devices have settled — every controller fn that needed the
  // uploaded file has finished reading it. Safe to delete exactly once,
  // right before we hand the response back.
  cleanupUploadedFile(req);

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
