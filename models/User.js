// models/User.js
//
// Source of truth for "what should every active device have for this
// user." The face image itself is stored as a durable, versioned JPEG on the
// application volume. Mongo stores only its relative path, keeping documents
// small while allowing any device to be retried without relying on a peer.
//
// VERSIONING: profileVersion and imageVersion are separate counters,
// each incremented only when that specific kind of data actually
// changes. This lets sync logic skip an image upload entirely when only
// profile fields changed, and vice versa.
//
// Neither version is a timestamp. Timestamps drift across retries and
// clock skew between requests; a plain incrementing integer makes "is
// device X caught up" an exact equality/inequality check with no
// ambiguity about near-simultaneous updates.

const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    employeeNo: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    userType: { type: String, default: "normal" },
    beginTime: { type: Date, default: null },
    endTime: { type: Date, default: null },

    // Bumped any time a profile field above changes. Does NOT change
    // when only the image changes.
    profileVersion: { type: Number, required: true, default: 1 },

    // Bumped any time the user's face image is replaced. Does NOT
    // change when only profile fields change.
    imageVersion: { type: Number, required: true, default: 1 },

    // Relative path to the durable JPEG used by retry and device catch-up.
    // Null is retained temporarily for users created before durable image
    // storage was introduced; retries report those records as blocked.
    faceImagePath: { type: String, default: null },

    status: {
      type: String,
      // A user is active as soon as it exists in our database. Per-device
      // DeviceUserSync rows track any outstanding registration retries.
      // Deleting prevents catch-up; inactive means deletion completed.
      enum: ["active", "deleting", "inactive"],
      default: "active",
    },
    deletionRequestedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("User", userSchema);
