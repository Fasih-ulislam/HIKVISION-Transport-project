// middleware/logger.js
const Log = require("../models/logsModel");

module.exports = (req, res, next) => {
  const start = Date.now();

  const originalJson = res.json;

  let responseBody;

  res.json = function (body) {
    responseBody = body;
    return originalJson.call(this, body);
  };

  res.on("finish", async () => {
    try {
      await Log.create({
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,

        requestBody: req.body,
        responseBody,

        params: req.params,
        query: req.query,

        durationMs: Date.now() - start,

        ip: req.ip,
      });
    } catch (err) {
      console.error("Log save failed:", err.message);
    }
  });

  next();
};
