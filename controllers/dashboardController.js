const HikDevice = require("../models/HikDevice");
const User = require("../models/User");
const DeviceUserSync = require("../models/DeviceUserSync");
const DeviceLog = require("../models/deviceLogsModel");
const Log = require("../models/logsModel");

function getSyncState(user, devices, rows) {
  const synced = [];
  const unsynced = [];
  for (const device of devices) {
    const row = rows.get(String(device._id));
    const caughtUp = row && row.syncedProfileVersion === user.profileVersion &&
      row.syncedImageVersion === user.imageVersion && row.profileStatus === "success" && row.imageStatus === "success";
    const result = {
      id: device._id, name: device.name || device.ip, ip: device.ip,
      status: row?.imageStatus === "blocked_no_source" ? "blocked_no_source" : (caughtUp ? "synced" : (row?.imageStatus || row?.profileStatus || "missing")),
    };
    (caughtUp ? synced : unsynced).push(result);
  }
  return { synced, unsynced };
}

module.exports.overview = async (req, res) => {
  try {
    const [devices, users, syncRows, recentEvents, requestLogs] = await Promise.all([
      HikDevice.find({}, "ip username name status lastStatus lastAttemptAt lastError createdAt").sort({ createdAt: -1 }).lean(),
      User.find({ status: "active" }).sort({ name: 1 }).lean(),
      DeviceUserSync.find({}).lean(),
      DeviceLog.find({}).sort({ time: -1 }).limit(10).populate("deviceId", "name ip").lean(),
      Log.countDocuments(),
    ]);
    const activeDevices = devices.filter((device) => device.status === "active");
    const rowsByUser = new Map();
    for (const row of syncRows) {
      const id = String(row.userId);
      if (!rowsByUser.has(id)) rowsByUser.set(id, new Map());
      rowsByUser.get(id).set(String(row.deviceId), row);
    }
    const userSync = users.map((user) => {
      const state = getSyncState(user, activeDevices, rowsByUser.get(String(user._id)) || new Map());
      return {
        id: user._id, employeeNo: user.employeeNo, name: user.name, userType: user.userType,
        syncedDeviceCount: state.synced.length, unsyncedDeviceCount: state.unsynced.length,
        syncedDevices: state.synced, unsyncedDevices: state.unsynced,
      };
    });
    const deviceSummary = devices.map((device) => ({
      ...device,
      syncedUsers: userSync.filter((user) => user.syncedDevices.some((item) => String(item.id) === String(device._id))).length,
      unsyncedUsers: userSync.filter((user) => user.unsyncedDevices.some((item) => String(item.id) === String(device._id))).length,
    }));
    const usersNotEverywhere = userSync.filter((user) => user.unsyncedDeviceCount > 0);
    const deviceEvents = await DeviceLog.countDocuments();
    return res.json({
      stats: {
        devices: devices.length, activeDevices: activeDevices.length, disabledDevices: devices.length - activeDevices.length,
        users: users.length, usersFullySynced: userSync.length - usersNotEverywhere.length,
        usersNeedingSync: usersNotEverywhere.length, deviceEvents, requestLogs,
      },
      devices: deviceSummary, users: userSync, usersNotEverywhere, recentEvents,
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
};

module.exports.deviceEvents = async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const filter = {};
  if (req.query.deviceId) filter.deviceId = req.query.deviceId;
  if (req.query.eventType) filter.eventType = req.query.eventType;
  const [events, total] = await Promise.all([
    DeviceLog.find(filter).sort({ time: -1 }).limit(limit).populate("deviceId", "name ip").lean(),
    DeviceLog.countDocuments(filter),
  ]);
  return res.json({ total, events });
};

module.exports.requestLogs = async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const [logs, total] = await Promise.all([
    Log.find({}).sort({ createdAt: -1 }).limit(limit).lean(), Log.countDocuments(),
  ]);
  return res.json({ total, logs });
};
