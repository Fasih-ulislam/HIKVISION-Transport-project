// controllers/deviceController.js
const HikDevice = require("../models/HikDevice");
const { encryptPassword } = require("../utils/crypto");

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
module.exports.setDeviceStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  if (!["active", "disabled"].includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be 'active' or 'disabled'" });
  }

  const device = await HikDevice.findByIdAndUpdate(
    id,
    { status },
    { returnDocument: "after", select: "ip name status" },
  );

  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  return res.json({ success: true, device });
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
