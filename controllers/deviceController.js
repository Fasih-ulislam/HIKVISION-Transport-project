// controllers/deviceController.js
const HikDevice = require("../models/HikDevice");
const { encryptPassword } = require("../utils/crypto");
const { catchUpDevice } = require("../services/userSyncService");

// ─── Register a new device ────────────────────────────────────────────────────
module.exports.registerDevice = async (req, res) => {
  const { ip, username, password, name } = req.body || {};

  if (!ip || !username || !password) {
    return res
      .status(400)
      .json({ error: "ip, username and password are required" });
  }

  try {
    const existing = await HikDevice.findOne({ ip });
    if (existing) {
      return res
        .status(409)
        .json({ error: `Device with IP ${ip} is already registered` });
    }

    const passwordEnc = encryptPassword(password);

    const device = await HikDevice.create({
      ip,
      username,
      passwordEnc,
      name: name || null,
      status: "active",
    });

    return res.status(201).json({
      success: true,
      device: {
        id: device._id,
        ip: device.ip,
        username: device.username,
        name: device.name,
        status: device.status,
      },
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({ error: "Failed to register device" });
  }
};

// ─── List devices (never returns credentials) ─────────────────────────────────
module.exports.listDevices = async (req, res) => {
  const devices = await HikDevice.find(
    {},
    "ip username name status lastStatus lastAttemptAt lastError createdAt",
  ).lean();

  return res.json({ success: true, devices });
};

// ─── Update device status (e.g. disable a misbehaving device) ────────────────
//
// CATCH-UP TRIGGER: when a device transitions disabled -> active, we kick
// off catchUpDevice in the background. It is NOT awaited before
// responding — with many active users, catch-up does one profile push
// per behind-user sequentially, and an admin flipping a device on
// should not have the request hang for that. The response confirms the
// status change immediately; catch-up progress/results land only in
// logs (and the DeviceUserSync rows it writes) for now, not in this
// response body.
//
// Re-confirming "active" on an already-active device, or disabling a
// device, does NOT trigger catch-up — only the actual disabled->active
// transition does. We have to read the device's PRIOR status before
// the update to know which transition this actually is; findByIdAndUpdate
// alone only gives us the after-state.
module.exports.setDeviceStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  if (!["active", "disabled"].includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be 'active' or 'disabled'" });
  }

  const before = await HikDevice.findById(id, "status");
  if (!before) {
    return res.status(404).json({ error: "Device not found" });
  }
  const wasDisabled = before.status === "disabled";

  const device = await HikDevice.findByIdAndUpdate(
    id,
    { status },
    { returnDocument: "after", select: "ip name status" },
  );

  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  const triggeringCatchUp = wasDisabled && status === "active";

  if (triggeringCatchUp) {
    // Fired and forgotten on purpose (see comment above). Wrapped so an
    // unexpected throw (e.g. device unreachable entirely, not just
    // individual user pushes failing — those are already handled inside
    // catchUpDevice) becomes a logged error instead of an unhandled
    // promise rejection that could crash the process.
    catchUpDevice(String(device._id)).catch((err) => {
      console.error(
        `[deviceController] catch-up failed for device ${device._id} (${device.ip}):`,
        err.message,
      );
    });
  }

  return res.json({
    success: true,
    device,
    catchUpTriggered: triggeringCatchUp,
  });
};

// ─── Remove a device ───────────────────────────────────────────────────────────
module.exports.deleteDevice = async (req, res) => {
  const { id } = req.params;
  const device = await HikDevice.findByIdAndDelete(id);

  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  return res.json({ success: true, message: `Device ${device.ip} removed` });
};
