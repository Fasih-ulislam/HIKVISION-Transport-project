// models/User.js
//
// Source of truth for "what should every active device have for this
// user." We deliberately do NOT persist the face image (binary or even
// a path) here — images are large enough that storing them per-user in
// Mongo adds real overhead for data we don't otherwise need to query or
// serve from our own DB. Devices are themselves the durable store for
// the image; when a lagging device needs catching up, we pull the
// current image from any peer device already at the current
// imageVersion (see DeviceUserSync) rather than keeping our own copy.
//
// VERSIONING: profileVersion and imageVersion are separate counters,
// each incremented only when that specific kind of data actually
// changes. This lets sync logic skip the (comparatively expensive)
// "pull image from a peer device" step entirely when only profile
// fields changed, and vice versa.
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
    // change when only profile fields change. There is no imageUrl /
    // imagePath field here by design — see module comment above.
    imageVersion: { type: Number, required: true, default: 1 },

    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("User", userSchema);
