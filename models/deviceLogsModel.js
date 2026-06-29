// models/DeviceLog.js
const mongoose = require("mongoose");

const deviceLogSchema = new mongoose.Schema(
  {
    deviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HikDevice",
      required: true,
    },
    major: { type: Number, required: true },
    minor: { type: Number, required: true },
    eventType: { type: String },
    time: { type: Date, required: true },
    employeeNoString: { type: String, default: null },
    name: { type: String, default: null },
    userType: { type: String, default: null },
    doorNo: { type: Number, default: null },
    cardType: { type: Number, default: null },
    cardReaderNo: { type: Number, default: null },
    serialNo: { type: Number },
    currentVerifyMode: { type: String, default: null },
    attendanceStatus: { type: String, default: null },
    mask: { type: String, default: null },
    pictureURL: { type: String, default: null },
    picturesNumber: { type: Number, default: null },
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: "devicelogs",
  },
);

// Prevent duplicate events using each device's own serialNo.
// IMPORTANT: serialNo is only unique *within* a device's own event
// counter — different devices can and will produce the same serialNo.
// The index must be compound (deviceId + serialNo), never serialNo alone,
// or events from a second device will collide with and silently
// overwrite/skip events from the first.
deviceLogSchema.index({ deviceId: 1, serialNo: 1 }, { unique: true });

module.exports = mongoose.model("DeviceLog", deviceLogSchema);
