const { hikRequest } = require("../utils/helperFuntions");

module.exports.deviceLogs = async (req, res) => {
  const {
    beginTime,
    endTime,
    position = 0,
    limit = 50,
    filter, // "verified" | "failed" | "all"
  } = req.query;

  const filterMap = {
    all: { major: 5, minor: 0 },
    verified: { major: 5, minor: 75 }, // face recognized, access granted
    blacklist: { major: 5, minor: 6 }, // blacklisted user attempt
    doorOpen: { major: 5, minor: 21 }, // door opened
    doorClose: { major: 5, minor: 22 }, // door closed / no face detected
    duplicate: { major: 5, minor: 104 }, // repeat scan too fast
  };

  const { major, minor } = filterMap[filter] || filterMap.all;

  const condition = {
    AcsEventCond: {
      searchID: Date.now().toString(),
      searchResultPosition: Number(position),
      maxResults: Number(limit),
      major,
      minor,
    },
  };

  // Add time range only if provided
  if (beginTime) condition.AcsEventCond.startTime = beginTime + "+05:00";
  if (endTime) condition.AcsEventCond.endTime = endTime + "+05:00";

  const result = await hikRequest(
    "POST",
    "/ISAPI/AccessControl/AcsEvent?format=json",
    condition,
  );

  if (!result.success) {
    return res
      .status(500)
      .json({ error: "Failed to fetch logs", detail: result.error });
  }

  return res.json({
    success: true,
    position: Number(position),
    limit: Number(limit),
    filter: filter || "all",
    data: result.data,
  });
};
