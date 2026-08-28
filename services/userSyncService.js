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
const fs = require("fs");
const DeviceUserSync = require("../models/DeviceUserSync");
const HikDevice = require("../models/HikDevice");
const { runAcrossDevices } = require("../utils/orchestrator");
const userController = require("../controllers/userController");
const { hikRequest, uploadFaceDirect } = require("../utils/helperFuntions");
const { decryptPassword } = require("../utils/crypto");
const {
  persistFaceImage,
  resolveFaceImagePath,
  removeFaceImage,
} = require("../utils/faceStorage");
const {
  recordProfileAttempt,
  recordImageAttempt,
  recordDeletionAttempt,
} = require("../utils/syncState");

const configuredRegistrationRetries = Number(process.env.REGISTRATION_MAX_RETRIES || 3);
const MAX_REGISTRATION_RETRIES =
  Number.isInteger(configuredRegistrationRetries) && configuredRegistrationRetries > 0
    ? configuredRegistrationRetries
    : 3;

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
 *   5. Keep the user and its durable image even if every device fails;
 *      the scheduled retry service will catch it up later.
 *
 * @param {object} req - the original Express req (body, file)
 * @returns {Promise<{ user: object, summary: object, results: Array, queuedForRetry: boolean }>}
 */
async function registerUser(req) {
  const { employeeNo, name, userType, beginTime, endTime } = req.body || {};

  // A rejected or previously deleted registration may be submitted again
  // with a corrected image. A live active/deleting user remains a conflict.
  const existingInactive = await User.findOne({
    employeeNo,
    status: { $in: ["inactive", "pending_registration", "pending_review"] },
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
    existingInactive.status = "pending_registration";
    existingInactive.registrationRetryCount = 0;
    existingInactive.registrationLastAttemptAt = new Date();
    existingInactive.registrationLastError = null;
    existingInactive.faceImagePath = await persistFaceImage(
      req.file,
      existingInactive._id,
      existingInactive.imageVersion,
    );
    try {
      user = await existingInactive.save();
    } catch (err) {
      await removeFaceImage(existingInactive.faceImagePath);
      throw err;
    }
  } else {
    user = new User({
      employeeNo,
      name,
      userType: userType || "normal",
      beginTime: beginTime || null,
      endTime: endTime || null,
      profileVersion: 1,
      imageVersion: 1,
      status: "pending_registration",
      registrationLastAttemptAt: new Date(),
    });
    user.faceImagePath = await persistFaceImage(req.file, user._id, 1);
    try {
      await user.save();
    } catch (err) {
      await removeFaceImage(user.faceImagePath);
      throw err;
    }
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

  const acceptedSomewhere = summary.succeeded > 0;
  user.status = acceptedSomewhere ? "active" : "pending_registration";
  user.registrationRetryCount = summary.total > 0 && !acceptedSomewhere ? 1 : 0;
  user.registrationLastAttemptAt = new Date();
  user.registrationLastError = acceptedSomewhere
    ? null
    : results.find((result) => result.error)?.error || "No active device accepted the registration";
  await user.save();

  return {
    user,
    summary,
    results,
    queuedForRetry: user.status === "pending_registration" || summary.failed > 0,
  };
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
  let newImagePath;
  if (hasImageChange) {
    const nextImageVersion = user.imageVersion + 1;
    newImagePath = await persistFaceImage(req.file, user._id, nextImageVersion);
    user.imageVersion = nextImageVersion;
    user.faceImagePath = newImagePath;
  }
  if (hasProfileChange || hasImageChange) {
    try {
      await user.save();
    } catch (err) {
      if (newImagePath) await removeFaceImage(newImagePath);
      throw err;
    }
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
 * Starts a durable deletion workflow. A user becomes `deleting` before any
 * device call, so normal catch-up can never recreate it on devices that have
 * already removed it. The retry worker keeps attempting outstanding devices
 * until every registered device has confirmed removal, then marks it inactive.
 *
 * @param {object} req - the original Express req (params.employeeNo)
 * @returns {Promise<{ user: object, summary: object, results: Array, fullyDeleted: boolean }>}
 */
async function deleteUser(req) {
  const { employeeNo } = req.params;

  const user = await User.findOne({
    employeeNo,
    status: { $in: ["active", "pending_registration", "pending_review", "deleting"] },
  });
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  user.status = "deleting";
  user.deletionRequestedAt = user.deletionRequestedAt || new Date();
  await user.save();

  const { summary, results } = await retryDeletionForUser(user);
  const fullyDeleted = await finalizeDeletion(user);

  return { user, summary, results, fullyDeleted };
}

/**
 * Performs deletion only for active devices which have not already confirmed
 * removal. Confirmation is retained in DeviceUserSync as an audit record.
 */
async function retryDeletionForUser(user) {
  const activeDevices = await HikDevice.find({ status: "active" }, "_id").lean();
  const rows = await DeviceUserSync.find({ userId: user._id }, "deviceId deletionStatus").lean();
  const completedIds = new Set(
    rows.filter((row) => row.deletionStatus === "success").map((row) => String(row.deviceId)),
  );
  const targetIds = activeDevices
    .map((device) => device._id)
    .filter((id) => !completedIds.has(String(id)));

  if (targetIds.length === 0) {
    return { summary: { total: 0, succeeded: 0, failed: 0 }, results: [] };
  }

  return runAcrossDevices(userController.deleteStudent, {
    params: { employeeNo: user.employeeNo },
  }, {
    filter: { _id: { $in: targetIds }, status: "active" },
    onDeviceSettled: (deviceDoc, outcome) =>
      recordDeletionAttempt(
        String(user._id),
        String(deviceDoc._id),
        outcome?.status === "success",
        outcome?.error,
      ),
  });
}

async function finalizeDeletion(user) {
  const devices = await HikDevice.find({}, "_id").lean();
  const rows = await DeviceUserSync.find(
    { userId: user._id, deletionStatus: "success" },
    "deviceId",
  ).lean();
  const completedIds = new Set(rows.map((row) => String(row.deviceId)));
  const fullyDeleted = devices.every((device) => completedIds.has(String(device._id)));

  if (fullyDeleted) {
    user.status = "inactive";
    await user.save();
  }
  return fullyDeleted;
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

/**
 * Advances pending registrations only when a device has confirmed both the
 * current profile and current face image. A bounded number of failed cron
 * attempts sends the record to pending_review instead of retrying forever.
 */
async function finalizePendingRegistrations() {
  const pendingUsers = await User.find({ status: "pending_registration" });
  const outcomes = [];

  for (const user of pendingUsers) {
    const rows = await DeviceUserSync.find({ userId: user._id }).lean();
    const acceptedSomewhere = rows.some(
      (row) =>
        row.syncedProfileVersion === user.profileVersion &&
        row.syncedImageVersion === user.imageVersion,
    );

    if (acceptedSomewhere) {
      user.status = "active";
      user.registrationRetryCount = 0;
      user.registrationLastError = null;
      await user.save();
      outcomes.push({ userId: String(user._id), status: "active" });
      continue;
    }

    // A cron pass that had active devices but no full acceptance is a real
    // retry attempt. No-device periods are not counted against the user.
    user.registrationRetryCount += 1;
    user.registrationLastAttemptAt = new Date();
    user.registrationLastError = "No active device has accepted both profile and face image";
    if (user.registrationRetryCount >= MAX_REGISTRATION_RETRIES) {
      user.status = "pending_review";
    }
    await user.save();
    outcomes.push({ userId: String(user._id), status: user.status });
  }

  return outcomes;
}

/** Retries every deletion that is waiting on one or more active devices. */
async function retryPendingDeletions() {
  const users = await User.find({ status: "deleting" });
  const outcomes = [];
  for (const user of users) {
    const { summary } = await retryDeletionForUser(user);
    const fullyDeleted = await finalizeDeletion(user);
    outcomes.push({ userId: String(user._id), summary, fullyDeleted });
  }
  return outcomes;
}

module.exports = {
  registerUser,
  updateUser,
  deleteUser,
  catchUpDevice,
  finalizePendingRegistrations,
  retryPendingDeletions,
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
 * Image catch-up uploads the current, versioned JPEG from durable local
 * storage, so it does not depend on another device being online.
 *
 * @param {string} deviceId
 * @returns {Promise<{ deviceId: string, checked: number, profileSynced: number, profileFailed: number, imageSynced: number, imageFailed: number, imageBlocked: number }>}
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

  const activeUsers = await User.find({
    status: { $in: ["active", "pending_registration"] },
  }).lean();

  let profileSynced = 0;
  let profileFailed = 0;
  let imageSynced = 0;
  let imageFailed = 0;
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
      let imagePath;
      try {
        imagePath = resolveFaceImagePath(user.faceImagePath);
      } catch (err) {
        await recordImageAttempt(
          String(user._id),
          String(deviceDoc._id),
          user.imageVersion,
          "blocked_no_source",
          err.message,
        );
        imageBlocked += 1;
        continue;
      }

      if (!imagePath || !fs.existsSync(imagePath)) {
        await recordImageAttempt(
          String(user._id),
          String(deviceDoc._id),
          user.imageVersion,
          "blocked_no_source",
          "Current face image is missing from durable storage.",
        );
        imageBlocked += 1;
        continue;
      }

      const imageResult = await uploadFaceDirect(
        deviceContext,
        user.employeeNo,
        imagePath,
        true,
      );
      await recordImageAttempt(
        String(user._id),
        String(deviceDoc._id),
        user.imageVersion,
        imageResult.success ? "success" : "failed",
        imageResult.error,
      );
      if (imageResult.success) imageSynced += 1;
      else imageFailed += 1;
    }
  }

  return {
    deviceId: String(deviceDoc._id),
    checked: activeUsers.length,
    profileSynced,
    profileFailed,
    imageSynced,
    imageFailed,
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
        beginTime: formatHikTime(user.beginTime),
        endTime: formatHikTime(user.endTime),
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

// Mongoose hydrates beginTime/endTime as Date instances, while the device
// requires the exact no-timezone form used by the public API.
function formatHikTime(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 19);
}
