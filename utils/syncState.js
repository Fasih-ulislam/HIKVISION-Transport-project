// utils/syncState.js
//
// Pure helper logic for reasoning about DeviceUserSync rows against a
// User's current versions. No DB calls in here except where explicitly
// noted — kept separate from controllers/orchestrator so the rules
// above (especially the "never optimistically bump synced*Version" and
// "no image source = hard failure" invariants) live in one place and
// are easy to unit test in isolation.

const DeviceUserSync = require("../models/DeviceUserSync");

/**
 * "completed" is never stored — always derived. See DeviceUserSync.js
 * header for why.
 */
function isFullySynced(syncRow, user) {
  return (
    syncRow.syncedProfileVersion === user.profileVersion &&
    syncRow.syncedImageVersion === user.imageVersion
  );
}

function needsProfilePush(syncRow, user) {
  return syncRow.syncedProfileVersion < user.profileVersion;
}

function needsImagePush(syncRow, user) {
  return syncRow.syncedImageVersion < user.imageVersion;
}

/**
 * Finds an active device (sync row) for this user that's already at the
 * user's CURRENT imageVersion and didn't just fail — i.e. a trustworthy
 * source to pull the image from for catching up a lagging device.
 *
 * Returns null if no such device exists. Callers MUST treat null as a
 * hard "cannot catch up image right now" state — never fall back to an
 * older image version, since that would let a device end up holding
 * image data that doesn't match whatever version we'd then record for
 * it (see CORE INVARIANT in DeviceUserSync.js).
 *
 * @param {string} userId
 * @param {object} user - the User doc (for its current imageVersion)
 * @param {string} [excludeDeviceId] - the lagging device we're trying to
 *   catch up; never pick it as its own source
 */
async function findImageSourceDevice(userId, user, excludeDeviceId) {
  const candidate = await DeviceUserSync.findOne({
    userId,
    deviceId: { $ne: excludeDeviceId },
    syncedImageVersion: user.imageVersion,
    imageStatus: { $ne: "failed" },
  }).lean();

  return candidate; // null if none found — caller must handle explicitly
}

/**
 * Records the outcome of a profile push attempt for one device.
 * Only advances syncedProfileVersion on success — see CORE INVARIANT.
 */
async function recordProfileAttempt(
  userId,
  deviceId,
  version,
  success,
  errorMessage,
) {
  const now = new Date();
  const update = {
    $set: {
      profileStatus: success ? "success" : "failed",
      lastProfileAttemptAt: now,
    },
    $push: {
      recentAttempts: {
        $each: [
          {
            kind: "profile",
            version,
            status: success ? "success" : "failed",
            error: success ? null : errorMessage || "Unknown error",
            attemptedAt: now,
          },
        ],
        $slice: -20, // keep only the most recent 20 attempts, any kind
      },
    },
  };

  // Only a confirmed success moves the durable "what does this device
  // actually have" marker forward.
  if (success) {
    update.$set.syncedProfileVersion = version;
  }

  await DeviceUserSync.findOneAndUpdate({ userId, deviceId }, update, {
    upsert: true,
    new: true,
  });
}

/**
 * Same as recordProfileAttempt but for image push/pull attempts, and
 * supports the extra "blocked_no_source" status for when catch-up
 * couldn't even be attempted because no peer device had the image.
 */
async function recordImageAttempt(
  userId,
  deviceId,
  version,
  status,
  errorMessage,
) {
  // status: "success" | "failed" | "blocked_no_source"
  const now = new Date();
  const update = {
    $set: {
      imageStatus: status,
      lastImageAttemptAt: now,
    },
    $push: {
      recentAttempts: {
        $each: [
          {
            kind: "image",
            version,
            status: status === "success" ? "success" : "failed",
            error: status === "success" ? null : errorMessage || status,
            attemptedAt: now,
          },
        ],
        $slice: -20,
      },
    },
  };

  if (status === "success") {
    update.$set.syncedImageVersion = version;
  }

  await DeviceUserSync.findOneAndUpdate({ userId, deviceId }, update, {
    upsert: true,
    new: true,
  });
}

/**
 * Given a user and all of their sync rows (one per active device),
 * returns a plain-English-ish summary useful for an admin view or for
 * deciding whether to even attempt a fresh push. Does not mutate
 * anything.
 */
function summarizeSync(user, syncRows) {
  const total = syncRows.length;
  let fullySynced = 0;
  let needsProfile = 0;
  let needsImage = 0;
  let blocked = 0;

  for (const row of syncRows) {
    if (isFullySynced(row, user)) {
      fullySynced += 1;
      continue;
    }
    if (needsProfilePush(row, user)) needsProfile += 1;
    if (needsImagePush(row, user)) needsImage += 1;
    if (row.imageStatus === "blocked_no_source") blocked += 1;
  }

  return {
    total,
    fullySynced,
    needsProfile,
    needsImage,
    blocked,
    // Mirrors the "if all were unsuccessful, the latest update failed,
    // keep the previous as latest" requirement: if literally zero
    // devices are fully synced to the CURRENT version, the update as a
    // whole has not taken effect anywhere yet.
    updateFullyFailed: total > 0 && fullySynced === 0,
  };
}

module.exports = {
  isFullySynced,
  needsProfilePush,
  needsImagePush,
  findImageSourceDevice,
  recordProfileAttempt,
  recordImageAttempt,
  summarizeSync,
};
