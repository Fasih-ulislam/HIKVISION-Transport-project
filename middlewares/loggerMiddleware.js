// middleware/logger.js
const Log = require("../models/logsModel");

const SECRET_FIELDS = new Set(["password", "passwordEnc", "faceImage", "image", "authorization"]);
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, SECRET_FIELDS.has(key) || /image|password/i.test(key) ? "[REDACTED]" : redact(item),
  ]));
}

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

        requestBody: redact(req.body),
        responseBody: redact(responseBody),

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
