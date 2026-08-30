const mongoose = require("mongoose");
const { startAlertStreams } = require("../services/alertStreamService");
const { startSyncRetryScheduler } = require("../services/syncRetryService");
const { startUisImportScheduler, runUisImport } = require("../services/uis/uisImportService");

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);

    console.log(
      `MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`,
    );
    runUisImport().catch((err) => console.error("[uis-import] unexpected startup failure:", err.message));
    startSyncRetryScheduler();
    //startUisImportScheduler();
    if (process.env.DEVICE_EVENT_STREAM_ENABLED === "true") startAlertStreams();
  } catch (error) {
    console.error("MongoDB Connection Error:", error.message);

    process.exit(1);
  }
};

module.exports = connectDB;
