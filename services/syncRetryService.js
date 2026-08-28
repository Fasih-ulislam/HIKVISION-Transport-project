// Repeatedly catches active devices up to the versions confirmed in Mongo.
const cron = require("node-cron");
const HikDevice = require("../models/HikDevice");
const {
  catchUpDevice,
  retryPendingDeletions,
} = require("./userSyncService");

let scheduledTask = null;
let retryRunInProgress = false;

async function runSyncRetry() {
  if (retryRunInProgress) {
    console.log("[sync-retry] previous run is still active; skipping overlap");
    return { skipped: true, reason: "already_running" };
  }
  retryRunInProgress = true;
  try {
    const devices = await HikDevice.find({ status: "active" }, "_id ip name").lean();
    const deletionResults = await retryPendingDeletions();
    const results = await Promise.all(devices.map(async (device) => {
      try { return await catchUpDevice(String(device._id)); }
      catch (err) {
        console.error(`[sync-retry] device ${device._id} (${device.ip}) failed:`, err.message);
        return { deviceId: String(device._id), error: err.message };
      }
    }));
    console.log(`[sync-retry] completed for ${devices.length} active device(s)`);
    return { skipped: false, results, deletionResults };
  } finally {
    retryRunInProgress = false;
  }
}

function startSyncRetryScheduler() {
  if (scheduledTask) return scheduledTask;
  const schedule = process.env.SYNC_RETRY_CRON || "*/5 * * * *";
  if (!cron.validate(schedule)) throw new Error(`Invalid SYNC_RETRY_CRON expression: ${schedule}`);
  scheduledTask = cron.schedule(schedule, () => {
    runSyncRetry().catch((err) => console.error("[sync-retry] unexpected scheduler failure:", err.message));
  });
  console.log(`[sync-retry] scheduled using "${schedule}"`);
  return scheduledTask;
}

function stopSyncRetryScheduler() { scheduledTask?.stop(); scheduledTask = null; }

module.exports = { runSyncRetry, startSyncRetryScheduler, stopSyncRetryScheduler };
