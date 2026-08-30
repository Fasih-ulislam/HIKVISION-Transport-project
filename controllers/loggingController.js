const DeviceLog = require("../models/deviceLogsModel");

module.exports.deviceLogs = async (req, res) => {
  try {
    const { beginTime, endTime, deviceId, filter } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const query = {};
    if (deviceId) query.deviceId = deviceId;
    if (beginTime || endTime) query.time = {};
    if (beginTime) query.time.$gte = new Date(beginTime);
    if (endTime) query.time.$lte = new Date(endTime);
    if (filter && filter !== "all") {
      const eventTypes = { verified: "face_verified", blacklist: "blacklist_detected", doorOpen: "door_opened", doorClose: "door_closed", duplicate: "duplicate_scan" };
      if (eventTypes[filter]) query.eventType = eventTypes[filter];
    }
    const [logs, total] = await Promise.all([
      DeviceLog.find(query).sort({ time: -1 }).limit(limit).populate("deviceId", "name ip").lean(),
      DeviceLog.countDocuments(query),
    ]);
    return res.json({ success: true, total, logs });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch stored device logs", detail: err.message });
  }
};
