const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const cron = require("node-cron");
const User = require("../../models/User");
const { registerUser, updateUser, deleteUser } = require("../userSyncService");
const { UisSoapClient } = require("./uisSoapClient");
const { processFaceImageBuffer } = require("../../utils/faceImageProcessor");

let scheduledTask = null;
let importInProgress = false;

function isUisConfigured() {
  return Boolean(process.env.UIS_API_URL && process.env.UIS_API_USER_ID && process.env.UIS_API_PASSWORD);
}

function parseUisDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!match) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const month = months[match[2].toUpperCase()];
  if (month === undefined) return null;
  const rawYear = Number(match[3]);
  const year = match[3].length === 2 ? 2000 + rawYear : rawYear;
  const date = new Date(Date.UTC(year, month, Number(match[1]), 0, 0, 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoDate(value, fallback) {
  return (parseUisDate(value) || fallback).toISOString();
}

function formatUisDate(date) {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${String(date.getDate()).padStart(2, "0")}-${months[date.getMonth()]}-${date.getFullYear()}`;
}

// Pulls in everything not yet marked, going back far enough that any
// historical backlog gets swept up once, not just today's registrations.
function newUserDateRange() {
  const yearsBack = Math.max(0, Number.parseInt(process.env.UIS_NEW_USERS_LOOKBACK_YEARS || "20", 10) || 20);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setFullYear(from.getFullYear() - yearsBack);
  return { dateFrom: formatUisDate(from), dateTo: formatUisDate(today) };
}

function mapUisStudent(record) {
  const employeeNo = String(record.RollNo || "").trim();
  const name = String(record.StudentName || "").trim();
  if (!employeeNo || !name) throw new Error("UIS detail is missing RollNo or StudentName");

  const begin = parseUisDate(record.EntryDate) || new Date();
  let end = parseUisDate(record.ExpiryDate) || new Date("2030-12-31T23:59:59.000Z");
  if (end <= begin) end = new Date("2030-12-31T23:59:59.000Z");

  return {
    employeeNo,
    name,
    // UIS documents BlockStatus as 1 = blocked and 0 = not blocked.
    userType: String(record.BlockStatus || "").trim() === "1" ? "blackList" : "normal",
    beginTime: toIsoDate(record.EntryDate, begin),
    endTime: end.toISOString(),
    faceImage: String(record.FrontPic || "").trim(),
    // "D" = delete, "A" = active (per UIS doc's Status A/D field).
    status: String(record.Status || "").trim().toUpperCase(),
    modifyRemarks: String(record.ModifyRemarks || "").trim(),
  };
}

async function makeFaceUpload(base64Image, formNo) {
  const cleanBase64 = String(base64Image || "")
    .replace(/^data:image\/[^;]+;base64,/i, "")
    .replace(/\s+/g, "");
  if (!cleanBase64) return null;

  const input = Buffer.from(cleanBase64, "base64");
  if (!input.length) throw new Error("UIS FrontPic is empty or invalid base64");

  // Same processing the /register and /update routes use via
  // decodeBase64Image, so a UIS-imported image and a directly-uploaded
  // one go through identical resize/quality logic.
  const output = await processFaceImageBuffer(input);

  const uploadDir = path.resolve(process.cwd(), "uploads");
  await fs.mkdir(uploadDir, { recursive: true });
  const filename = `uis-${formNo}-${Date.now()}-${crypto.randomUUID()}.jpg`;
  const filePath = path.join(uploadDir, filename);
  await fs.writeFile(filePath, output);
  return { filename, path: filePath, mimetype: "image/jpeg", size: output.length };
}

async function removeUpload(file) {
  if (!file?.path) return;
  try { await fs.unlink(file.path); } catch (err) { if (err.code !== "ENOENT") throw err; }
}

// Errors that mean "we couldn't reach/trust this device," not "the device
// evaluated the image and rejected it." Heuristic based on common
// connectivity/credential failure text — if utils/helperFuntions.js gives
// hikRequest/uploadFaceDirect a more structured error shape later, this
// can be replaced with an exact check instead of pattern-matching.
const CONNECTIVITY_ERROR_PATTERN = /timeout|timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|network|unreachable|decrypt/i;

function classifyDeviceImageOutcome(deviceResult) {
  const imagePart = deviceResult?.raw?.parts?.image;
  // No parts.image at all means either the device never got far enough
  // to attempt the image (credential/connection failure before the call,
  // or an unexpected throw caught by the orchestrator) — not evidence
  // the image itself is bad.
  if (!imagePart) return "unknown";
  if (imagePart.success) return "accepted";
  if (imagePart.error && CONNECTIVITY_ERROR_PATTERN.test(imagePart.error)) return "unknown";
  return "rejected";
}

// Turns a registerUser/updateUser outcome into a FraiVerifyStatus/remarks
// pair. Rule: if even one device confirms the image is fine, the image
// isn't at fault — any other failing devices are a device-level problem
// for the existing catch-up retry service to handle, not FRAI's concern.
// Only mark the image itself bad when nothing accepted it and at least
// one device gave a real (non-connectivity) rejection.
function buildFraiOutcome({ summary, results }) {
  if (!summary || summary.total === 0) {
    return { status: "N", remarks: "No active devices available to verify image" };
  }

  const classified = results.map(classifyDeviceImageOutcome);
  const acceptedCount = classified.filter((c) => c === "accepted").length;
  const rejectedIndex = classified.findIndex((c) => c === "rejected");

  if (acceptedCount > 0) {
    return { status: "Y", remarks: "Registration successful" };
  }

  if (rejectedIndex !== -1) {
    const error = results[rejectedIndex]?.raw?.parts?.image?.error;
    const remarks = `Image not accepted by device${error ? `: ${error}` : ""}`;
    return { status: "N", remarks: remarks.slice(0, 250) };
  }

  // Nothing accepted, nothing explicitly rejected either — every device
  // outcome was inconclusive (offline, bad credentials, etc.).
  return { status: "N", remarks: "Could not verify image — devices unreachable" };
}

async function importOne(client, formNo) {
  const detail = await client.getUserDetail(formNo);
  const student = mapUisStudent(detail);

  if (student.status === "D") {
    await deleteUser({ params: { employeeNo: student.employeeNo } });
    await client.markRegisteredUser(formNo);
    return { formNo, action: "deleted" };
  }

  const existing = await User.findOne({ employeeNo: student.employeeNo }, "status").lean();
  if (existing?.status === "deleting") {
    throw new Error(`User ${student.employeeNo} is currently deleting`);
  }

  // A brand-new record always needs its picture. For a record that's
  // already on file, only touch the picture when UIS explicitly says it
  // changed — everything else is a plain field update.
  const isNewRecord = !existing;
  const picChanged = isNewRecord || student.modifyRemarks === "Front Picture Changed";

  const faceFile = picChanged ? await makeFaceUpload(student.faceImage, formNo) : null;

  let syncOutcome;
  try {
    if (existing?.status === "active") {
      syncOutcome = await updateUser({
        params: { employeeNo: student.employeeNo },
        body: {
          name: student.name,
          userType: student.userType,
          beginTime: student.beginTime,
          endTime: student.endTime,
        },
        file: faceFile || undefined,
      });
    } else {
      if (!faceFile) throw new Error(`UIS user ${student.employeeNo} has no FrontPic for registration`);
      syncOutcome = await registerUser({ body: student, file: faceFile });
    }
  } finally {
    await removeUpload(faceFile);
  }

  // FRAI reflects whether the DEVICE actually accepted the picture, so
  // it's only meaningful when a picture was actually pushed this round.
  if (picChanged) {
    const fraiOutcome = buildFraiOutcome(syncOutcome);
    await client.markFraiVerification(formNo, fraiOutcome);
  }

  await client.markRegisteredUser(formNo);
  return { formNo, action: existing ? "updated" : "registered" };
}

async function runUisImport() {
  if (importInProgress) return { skipped: true, reason: "already_running" };
  if (!isUisConfigured()) return { skipped: true, reason: "not_configured" };

  importInProgress = true;
  try {
    const client = new UisSoapClient();
    const { dateFrom, dateTo } = newUserDateRange();
    const [newResult, modifiedResult] = await Promise.allSettled([
      client.getNewRegisteredUsers(dateFrom, dateTo),
      client.getModifiedUsers(),
    ]);
    const errors = [];
    if (newResult.status === "rejected") errors.push({ source: "new", error: newResult.reason.message });
    if (modifiedResult.status === "rejected") errors.push({ source: "modified", error: modifiedResult.reason.message });

    // Status/ModifyRemarks from the detail call drive every downstream
    // decision now, so all we need here is the set of formNos to process
    // — no need to track which list each one came from.
    const formNos = new Set();
    if (newResult.status === "fulfilled") {
      for (const record of newResult.value) {
        const formNo = String(record.FormNo || "").trim();
        if (formNo) formNos.add(formNo);
      }
    }
    if (modifiedResult.status === "fulfilled") {
      for (const record of modifiedResult.value) {
        const formNo = String(record.FormNo || "").trim();
        if (formNo) formNos.add(formNo);
      }
    }

    const results = [];
    for (const formNo of formNos) {
      try { results.push(await importOne(client, formNo)); }
      catch (err) {
        console.error(`[uis-import] ${formNo} failed:`, err.message);
        results.push({ formNo, action: "failed", error: err.message });
      }
    }
    console.log(`[uis-import] processed ${formNos.size} record(s) from ${dateFrom} to ${dateTo}`);
    return { skipped: false, dateFrom, dateTo, results, errors };
  } finally {
    importInProgress = false;
  }
}

function startUisImportScheduler() {
  if (scheduledTask || !isUisConfigured()) {
    if (!scheduledTask && !isUisConfigured()) console.log("[uis-import] scheduler disabled: UIS API is not configured");
    return scheduledTask;
  }
  const schedule = process.env.UIS_SYNC_CRON || "*/5 * * * *";
  if (!cron.validate(schedule)) throw new Error(`Invalid UIS_SYNC_CRON expression: ${schedule}`);
  scheduledTask = cron.schedule(schedule, () => {
    runUisImport().catch((err) => console.error("[uis-import] unexpected scheduler failure:", err.message));
  });
  console.log(`[uis-import] scheduled using "${schedule}"`);
  return scheduledTask;
}

function stopUisImportScheduler() { scheduledTask?.stop(); scheduledTask = null; }

module.exports = { runUisImport, startUisImportScheduler, stopUisImportScheduler, mapUisStudent, newUserDateRange };