// services/userSyncService.js
//
// Owns the full lifecycle of a user create/update request, end to end:
//   1. Persist the change to User (bumping profileVersion / imageVersion
//      exactly ONCE, here, before any device is touched).
//   2. Fan the push out across active devices via the orchestrator.
//   3. Record each device's outcome into DeviceUserSync as it settles.
//
// WHY THE VERSION BUMP LIVES HERE AND NOT IN THE CONTROLLER:
// userController.update/register run once PER DEVICE (orchestrator calls
// them N times for N devices). If the version bump happened inside them,
// it would happen N times per request, and — worse — different devices
// could end up racing to push against different version numbers if the
// bump weren't atomic with the read every device's attempt is judged
// against. Bumping once, here, before fan-out, means every device in
// this request is unambiguously being pushed "version 4" (say), and
// whether each one succeeds or fails is recorded against that exact
// number.
//
// This file is intentionally the only place that writes to both User and
// DeviceUserSync for a given request — controllers and the orchestrator
// stay ignorant of sync-table concerns entirely.

const User = require("../models/User");
const DeviceUserSync = require("../models/DeviceUserSync");
const HikDevice = require("../models/HikDevice");
const { runAcrossDevices } = require("../utils/orchestrator");
const userController = require("../controllers/userController");
const { hikRequest } = require("../utils/helperFuntions");
const { decryptPassword } = require("../utils/crypto");
const {
  recordProfileAttempt,
  recordImageAttempt,
} = require("../utils/syncState");

/**
 * Registers a new user — or reactivates a previously soft-deleted one
 * with the same employeeNo (handles the "student leaves, new student
 * gets same ID" case without blocking re-registration).
 *
 * Flow:
 *   1. Check for an existing inactive User with this employeeNo.
 *      - Found → reactivate in place, bump both versions.
 *      - Not found → create fresh at version 1/1.
 *   2. Pre-create pending DeviceUserSync rows for all active devices.
 *   3. Fan out to every active device via orchestrator.
 *   4. Record each device's outcome.
 *   5. ROLLBACK if every device failed:
 *      - Reactivation path → flip back to inactive (preserves history).
 *      - Fresh create path → hard delete (no history worth keeping).
 *
 * @param {object} req - the original Express req (body, file)
 * @returns {Promise<{ user: object|null, summary: object, results: Array, rolledBack: boolean }>}
 */
async function registerUser(req) {
  const { employeeNo, name, userType, beginTime, endTime } = req.body || {};

  // Check for a previously soft-deleted record with the same employeeNo.
  // A live (status: "active") duplicate is a real conflict and should
  // fall through to User.create() so the unique-index error surfaces
  // naturally as a 500 — callers should deduplicate before registering.
  const existingInactive = await User.findOne({
    employeeNo,
    status: "inactive",
  });

  const wasReactivated = !!existingInactive;
  let user;

  if (wasReactivated) {
    // Reactivate in place — bump both versions so any stale sync rows
    // from the previous person's registration are clearly behind and
    // won't be mistaken for a valid sync state for the new person.
    existingInactive.name = name;
    existingInactive.userType = userType || "normal";
    existingInactive.beginTime = beginTime || null;
    existingInactive.endTime = endTime || null;
    existingInactive.profileVersion += 1;
    existingInactive.imageVersion += 1;
    existingInactive.status = "active";
    user = await existingInactive.save();
  } else {
    user = await User.create({
      employeeNo,
      name,
      userType: userType || "normal",
      beginTime: beginTime || null,
      endTime: endTime || null,
      profileVersion: 1,
      imageVersion: 1,
    });
  }

  // Pre-create pending rows for every active device targeted by this
  // request, BEFORE fan-out starts. This closes the window where a
  // query for this user's sync status would see zero rows and be unable
  // to distinguish "registration in flight" from "user has no devices."
  const activeDevices = await HikDevice.find({ status: "active" }).lean();
  if (activeDevices.length > 0) {
    await DeviceUserSync.insertMany(
      activeDevices.map((d) => ({
        userId: user._id,
        deviceId: d._id,
        // syncedProfileVersion/syncedImageVersion default to 0 — this
        // user hasn't been confirmed on any device yet, which is exactly
        // the pre-fan-out truth.
        profileStatus: "pending",
        imageStatus: "pending",
      })),
      { ordered: false },
    );
  }

  const { summary, results } = await runAcrossDevices(
    userController.register,
    req,
    {
      onDeviceSettled: (deviceDoc, outcome) =>
        recordDeviceOutcome(user, deviceDoc, outcome),
    },
  );

  if (summary.total > 0 && summary.succeeded === 0) {
    // Every device failed — this user never actually took effect
    // anywhere. Roll back to avoid leaving a permanently-stuck record.
    await DeviceUserSync.deleteMany({ userId: user._id });

    if (wasReactivated) {
      // Preserve history — just flip back to inactive rather than
      // hard-deleting. The previous person's audit trail stays intact.
      user.status = "inactive";
      await user.save();
    } else {
      // Fresh create with no history worth keeping — hard delete.
      await User.deleteOne({ _id: user._id });
    }

    return { user: null, summary, results, rolledBack: true };
  }

  return { user, summary, results, rolledBack: false };
}

/**
 * Updates an existing user: bumps whichever version(s) actually changed
 * BEFORE fan-out, then pushes to every active device, recording each
 * device's outcome against the new version number(s).
 *
 * @param {object} req - the original Express req (params.employeeNo, body, file)
 * @returns {Promise<{ user: object, summary: object, results: Array }>}
 */
async function updateUser(req) {
  const { employeeNo } = req.params;
  const { userType, beginTime, endTime, name } = req.body || {};
  const hasProfileChange = !!(userType || beginTime || endTime || name);
  const hasImageChange = !!req.file;

  const user = await User.findOne({ employeeNo, status: "active" });
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  // Bump exactly once, here, before any device sees this request. Every
  // device's attempt below is judged against these exact numbers.
  if (hasProfileChange) {
    user.profileVersion += 1;
    if (name) user.name = name;
    if (userType) user.userType = userType;
    if (beginTime) user.beginTime = beginTime;
    if (endTime) user.endTime = endTime;
  }
  if (hasImageChange) {
    user.imageVersion += 1;
  }
  if (hasProfileChange || hasImageChange) {
    await user.save();
  }

  const { summary, results } = await runAcrossDevices(
    userController.update,
    req,
    {
      onDeviceSettled: (deviceDoc, outcome) =>
        recordDeviceOutcome(user, deviceDoc, outcome),
    },
  );

  return { user, summary, results };
}

/**
 * Deletes a user from every active device, pruning that device's
 * DeviceUserSync row as each deletion is confirmed. The User document
 * itself is only ever SOFT-deleted (status: "inactive") — never
 * removed from our DB — and only once every targeted active device has
 * confirmed the deletion. If any device fails to delete, the User row
 * stays "active" and the still-pending devices remain as ordinary
 * catch-up candidates (their sync row simply isn't pruned yet); a
 * retry of this same deleteUser call will re-attempt only the
 * still-present rows' devices implicitly, since deletion on an already
 * up-to-date device is harmless to repeat.
 *
 * WHY SOFT-DELETE: keeps the User row as a durable record (audit trail,
 * "previously enrolled" history) without it being treated as a live,
 * syncable user — catch-up sweeps and update flows should always filter
 * on status: "active" so an inactive/soft-deleted user is never
 * accidentally re-pushed to a device that's catching up.
 *
 * @param {object} req - the original Express req (params.employeeNo)
 * @returns {Promise<{ user: object, summary: object, results: Array, fullyDeleted: boolean }>}
 */
async function deleteUser(req) {
  const { employeeNo } = req.params;

  const user = await User.findOne({ employeeNo, status: "active" });
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  const { summary, results } = await runAcrossDevices(
    userController.deleteStudent,
    req,
    {
      onDeviceSettled: (deviceDoc, outcome) =>
        pruneSyncRowOnDelete(user, deviceDoc, outcome),
    },
  );

  const fullyDeleted =
    summary.total === 0 || summary.succeeded === summary.total;

  if (fullyDeleted) {
    user.status = "inactive";
    await user.save();
  }
  // If not fully deleted: User stays "active" on purpose. The devices
  // that DID succeed already had their sync rows pruned (see below);
  // the ones that failed still have a row, so they surface naturally
  // as "needs deletion retry" rather than silently vanishing from view.

  return { user, summary, results, fullyDeleted };
}

/**
 * Removes a device's DeviceUserSync row once that device confirms the
 * user was deleted. A failed deletion leaves the row in place — it's
 * not "synced" in either direction, it's "still has stale data we
 * couldn't remove," which is exactly what an admin retrying deletion
 * needs to be able to see.
 */
async function pruneSyncRowOnDelete(user, deviceDoc, outcome) {
  if (outcome?.status !== "success") return;
  await DeviceUserSync.deleteOne({
    userId: user._id,
    deviceId: deviceDoc._id,
  });
}

/**
 * Translates one device's raw controller outcome (from orchestrator's
 * onDeviceSettled) into the appropriate recordProfileAttempt /
 * recordImageAttempt calls.
 *
 * Relies on controller functions populating `result.parts.profile` /
 * `result.parts.image` (see userController.js) to know which sub-parts
 * were actually attempted — a part absent from `parts` is treated as
 * "not attempted this request" and is NOT recorded as a failure, since
 * recording a failure for something we never tried would incorrectly
 * make a fine, untouched device look broken. If a controller fn reports
 * neither part, nothing is recorded and a loud error is logged rather
 * than guessing — see the bottom of this function.
 */
async function recordDeviceOutcome(user, deviceDoc, outcome) {
  const deviceId = String(deviceDoc._id);
  const userId = String(user._id);
  const parts = outcome?.raw?.parts || {};

  if (parts.profile) {
    await recordProfileAttempt(
      userId,
      deviceId,
      user.profileVersion,
      parts.profile.success,
      parts.profile.error,
    );
  }

  if (parts.image) {
    await recordImageAttempt(
      userId,
      deviceId,
      user.imageVersion,
      parts.image.success ? "success" : "failed",
      parts.image.error,
    );
  }

  // Every migrated controller fn (register, update) populates `parts`.
  // If neither key is present, we don't know what this fn actually
  // attempted — guessing would risk recording a profile or image
  // attempt that never happened, which corrupts the sync table far
  // worse than recording nothing. Log loudly instead so an unmigrated
  // controller fn doesn't fail silently.
  if (!parts.profile && !parts.image) {
    console.error(
      `[userSyncService] device ${deviceId} outcome had no parts.profile/parts.image — ` +
        `controller fn did not report sub-results. Sync state NOT recorded for this device. ` +
        `If this fn is meant to be tracked, update it to populate result.parts.`,
    );
  }
}

module.exports = {
  registerUser,
  updateUser,
  deleteUser,
  catchUpDevice,
};

/**
 * Catches up a single device against every active user it's behind on —
 * intended to be called the moment a device flips from "inactive" to
 * "active" (event-driven, not polled). Also safe to call on an
 * already-active device as a manual "re-sync this device" operation;
 * it's a no-op for users that are already fully synced.
 *
 * PROFILE catch-up is fully implemented: re-runs the same per-device
 * profile-update ISAPI call userController.update uses, sourced from
 * our own DB (no peer device needed — we already have the canonical
 * profile fields in User).
 *
 * IMAGE catch-up is INTENTIONALLY STUBBED. Per design, catching up an
 * image requires pulling the current face from a peer device already
 * at the user's current imageVersion (we don't persist images
 * ourselves — see User.js header). That requires a "fetch face image
 * from device" ISAPI call that does not exist yet in helperFuntions.js
 * (only uploadFaceDirect / deleteFace, both push-only, exist today).
 * Calling this with a user that needs image catch-up will record a
 * loud, visible "blocked_no_source" failure via recordImageAttempt —
 * it will NEVER silently skip or silently mark an image as synced
 * when it wasn't actually pushed. Implement the real pull-and-push
 * once that endpoint is available, then replace the stub below.
 *
 * @param {string} deviceId
 * @returns {Promise<{ deviceId: string, checked: number, profileSynced: number, profileFailed: number, imageBlocked: number }>}
 */
async function catchUpDevice(deviceId) {
  const deviceDoc = await HikDevice.findById(deviceId).lean();
  if (!deviceDoc) {
    const err = new Error("Device not found");
    err.status = 404;
    throw err;
  }
  if (deviceDoc.status !== "active") {
    const err = new Error("Cannot catch up a device that is not active");
    err.status = 400;
    throw err;
  }

  const deviceContext = {
    deviceId: String(deviceDoc._id),
    ip: deviceDoc.ip,
    username: deviceDoc.username,
    password: decryptPassword(deviceDoc.passwordEnc),
  };

  const activeUsers = await User.find({ status: "active" }).lean();

  let profileSynced = 0;
  let profileFailed = 0;
  let imageBlocked = 0;

  for (const user of activeUsers) {
    const syncRow = await DeviceUserSync.findOne({
      userId: user._id,
      deviceId: deviceDoc._id,
    }).lean();

    const syncedProfileVersion = syncRow ? syncRow.syncedProfileVersion : 0;
    const syncedImageVersion = syncRow ? syncRow.syncedImageVersion : 0;

    if (syncedProfileVersion < user.profileVersion) {
      const result = await pushProfileToDevice(deviceContext, user);
      await recordProfileAttempt(
        String(user._id),
        String(deviceDoc._id),
        user.profileVersion,
        result.success,
        result.error,
      );
      if (result.success) profileSynced += 1;
      else profileFailed += 1;
    }

    if (syncedImageVersion < user.imageVersion) {
      // STUB — see function header. Recorded honestly as blocked, never
      // as a fabricated success.
      await recordImageAttempt(
        String(user._id),
        String(deviceDoc._id),
        user.imageVersion,
        "blocked_no_source",
        "Image catch-up not yet implemented: no face-retrieval endpoint exists to pull the current image from a peer device.",
      );
      imageBlocked += 1;
    }
  }

  return {
    deviceId: String(deviceDoc._id),
    checked: activeUsers.length,
    profileSynced,
    profileFailed,
    imageBlocked,
  };
}

/**
 * Pushes one user's current profile fields to one device. This is the
 * same ISAPI call userController.update makes for the profile half of
 * an update, but invoked directly against a single device outside the
 * orchestrator's per-request fan-out, since catch-up is "one device,
 * many users" rather than "one user, many devices."
 */
async function pushProfileToDevice(deviceContext, user) {
  const currentUser = await hikRequest(
    deviceContext,
    "POST",
    "/ISAPI/AccessControl/UserInfo/Search?format=json",
    {
      UserInfoSearchCond: {
        searchID: "1",
        searchResultPosition: 0,
        maxResults: 1,
        EmployeeNoList: [{ employeeNo: user.employeeNo }],
      },
    },
  );

  const userExistsOnDevice =
    currentUser.success && currentUser.data?.UserInfoSearch?.UserInfo?.[0];

  const payload = {
    UserInfo: {
      employeeNo: user.employeeNo,
      name: user.name,
      userType: user.userType || "normal",
      doorRight: "1",
      Valid: {
        enable: true,
        beginTime: user.beginTime,
        endTime: user.endTime,
      },
    },
  };

  // If the device never had this user at all (e.g. user was created
  // while this device was disabled), create rather than modify.
  const result = userExistsOnDevice
    ? await hikRequest(
        deviceContext,
        "PUT",
        "/ISAPI/AccessControl/UserInfo/Modify?format=json",
        payload,
      )
    : await hikRequest(
        deviceContext,
        "POST",
        "/ISAPI/AccessControl/UserInfo/Record",
        {
          UserInfo: {
            ...payload.UserInfo,
            RightPlan: [{ doorNo: 1, planTemplateNo: "1" }],
          },
        },
      );

  if (!result.success) {
    return { success: false, error: result.error || "Failed to push profile" };
  }
  return { success: true };
}
