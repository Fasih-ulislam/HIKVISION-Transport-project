// models/DeviceUserSync.js
//
// Junction table: one row per (user, device) pair, for devices we
// actively manage. This is the table the app reads on every "is this
// device caught up" check — it should stay a cheap, current-state
// lookup. Full attempt history is kept too, but only as a small bounded
// array for debugging/audit; logic should never need to scan it.
//
// CORE INVARIANT — read this before touching sync logic:
//   syncedProfileVersion / syncedImageVersion only ever advance on a
//   CONFIRMED SUCCESSFUL push to that specific device. They are never
//   optimistically bumped, never bumped on retry-scheduled, never
//   bumped because "it'll probably work." If you violate this, a
//   device can claim to be at version N while actually running stale
//   data, and another device could pull that stale data thinking it's
//   current — silently corrupting the whole sync guarantee.
//
// "Fully caught up" / "completed" is NOT a stored field — it is always
// derived as:
//     syncedProfileVersion === user.profileVersion
//     && syncedImageVersion === user.imageVersion
// Storing it separately would let it drift from the truth (e.g. user
// gets updated, someone forgets to flip every junction row back to
// false). Deriving it means it can never lie.
//
// IMAGE SOURCING RULE for catch-up logic (enforced by the app, not the
// schema, but documented here since this table is what answers it):
//   To push a missing image to a lagging device, pick any OTHER row
//   for the same userId where syncedImageVersion === user.imageVersion
//   and status is not "failed", and pull the image from that device.
//   If no such row exists, catching up the image is NOT possible right
//   now — this must surface as a hard, visible failure state (e.g.
//   syncStatus: "blocked_no_source"), never silently retried with an
//   older image, since that would mean a device ends up holding image
//   data that doesn't match the version we'd record for it.

const mongoose = require("mongoose");

const attemptSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["profile", "image"], required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ["success", "failed"], required: true },
    error: { type: String, default: null },
    attemptedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const deviceUserSyncSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    deviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HikDevice",
      required: true,
    },

    // Last version of each kind that was CONFIRMED applied on this
    // device. 0 means "never successfully synced" (e.g. brand new
    // pairing, user added after this device, etc.) — never null/undefined,
    // so version comparisons (`0 < user.profileVersion`) always behave
    // correctly without extra null-checks at every call site.
    syncedProfileVersion: { type: Number, required: true, default: 0 },
    syncedImageVersion: { type: Number, required: true, default: 0 },

    // Status of the most recent attempt for EACH kind, independent of
    // each other — a device can be failing image pushes while profile
    // pushes succeed, or vice versa.
    profileStatus: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "pending",
    },
    imageStatus: {
      type: String,
      enum: ["pending", "success", "failed", "blocked_no_source"],
      default: "pending",
    },

    lastProfileAttemptAt: { type: Date, default: null },
    lastImageAttemptAt: { type: Date, default: null },

    // Bounded recent history for debugging/audit only. Capped at 20 via
    // application logic (push + $slice in the update), never read by
    // sync decision logic — only by anyone investigating a specific
    // device's history by hand.
    recentAttempts: { type: [attemptSchema], default: [] },
  },
  { timestamps: true },
);

// A device should only ever have one sync row per user.
deviceUserSyncSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

// Fast lookup direction for "which users still need syncing on this device"
deviceUserSyncSchema.index({ deviceId: 1 });

module.exports = mongoose.model("DeviceUserSync", deviceUserSyncSchema);
