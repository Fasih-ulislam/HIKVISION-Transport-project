// models/HikDevice.js
const mongoose = require("mongoose");

const credentialSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
  },
  { _id: false },
);

const hikDeviceSchema = new mongoose.Schema(
  {
    name: { type: String, default: null }, // optional human label, e.g. "Bus 14"
    ip: { type: String, required: true, unique: true, trim: true },
    username: { type: String, required: true },
    passwordEnc: { type: credentialSchema, required: true },

    status: {
      type: String,
      enum: ["active", "disabled"],
      default: "active",
    },

    // Operational visibility — cheap to maintain, useful once you have a fleet
    lastStatus: {
      type: String,
      enum: ["success", "failed", null],
      default: null,
    },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: "hikdevices",
  },
);

module.exports = mongoose.model("HikDevice", hikDeviceSchema);
