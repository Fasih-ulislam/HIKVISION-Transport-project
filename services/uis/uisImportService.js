const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const cron = require("node-cron");
const User = require("../../models/User");
const UisImportState = require("../../models/UisImportState");
const { registerUser, updateUser } = require("../userSyncService");
const { UisSoapClient } = require("./uisSoapClient");

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

function newUserDateRange() {
  const lookback = Math.max(0, Number.parseInt(process.env.UIS_NEW_USERS_LOOKBACK_DAYS || "0", 10) || 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setDate(from.getDate() - lookback);
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
  };
}

function fingerprint(student) {
  return crypto.createHash("sha256").update(JSON.stringify(student)).digest("hex");
}

async function makeFaceUpload(base64Image, formNo) {
  const cleanBase64 = String(base64Image || "")
    .replace(/^data:image\/[^;]+;base64,/i, "")
    .replace(/\s+/g, "");
  if (!cleanBase64) return null;

  const input = Buffer.from(cleanBase64, "base64");
  if (!input.length) throw new Error("UIS FrontPic is empty or invalid base64");

  const attempts = [
    { width: 1200, quality: 85 },
    { width: 800, quality: 75 },
    { width: 600, quality: 65 },
    { width: 400, quality: 50 },
  ];
  let output;
  for (const attempt of attempts) {
    output = await sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width: attempt.width, withoutEnlargement: true })
      .jpeg({ quality: attempt.quality })
      .toBuffer();
    if (output.length <= 200 * 1024) break;
  }
  if (!output || output.length > 200 * 1024) {
    throw new Error("UIS FrontPic could not be compressed below 200 KB");
  }

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

async function markIfNeeded(client, state, formNo, isNewRecord) {
  if (!isNewRecord || state?.registeredMarkedAt) return;
  await client.markRegisteredUser(formNo);
  await UisImportState.updateOne({ formNo }, { $set: { registeredMarkedAt: new Date() } });
}

async function importOne(client, { formNo, isNewRecord }) {
  const detail = await client.getUserDetail(formNo);
  const student = mapUisStudent(detail);
  const currentFingerprint = fingerprint(student);
  const state = await UisImportState.findOne({ formNo }).lean();

  if (state?.fingerprint === currentFingerprint) {
    await markIfNeeded(client, state, formNo, isNewRecord);
    return { formNo, action: "skipped_unchanged" };
  }

  const existing = await User.findOne({ employeeNo: student.employeeNo }, "status").lean();
  if (existing?.status === "deleting") {
    throw new Error(`User ${student.employeeNo} is currently deleting`);
  }

  const faceFile = await makeFaceUpload(student.faceImage, formNo);
  try {
    if (existing?.status === "active") {
      await updateUser({
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
      await registerUser({ body: student, file: faceFile });
    }
  } finally {
    await removeUpload(faceFile);
  }

  await UisImportState.findOneAndUpdate(
    { formNo },
    {
      $set: {
        fingerprint: currentFingerprint,
        lastImportedAt: new Date(),
      },
      $setOnInsert: { registeredMarkedAt: null },
    },
    { upsert: true, new: true },
  );
  await markIfNeeded(client, await UisImportState.findOne({ formNo }).lean(), formNo, isNewRecord);
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

    const records = new Map();
    if (newResult.status === "fulfilled") {
      for (const record of newResult.value) {
        const formNo = String(record.FormNo || "").trim();
        if (formNo) records.set(formNo, { formNo, isNewRecord: true });
      }
    }
    if (modifiedResult.status === "fulfilled") {
      for (const record of modifiedResult.value) {
        const formNo = String(record.FormNo || "").trim();
        if (!formNo) continue;
        records.set(formNo, { formNo, isNewRecord: records.get(formNo)?.isNewRecord || false });
      }
    }

    const results = [];
    for (const record of records.values()) {
      try { results.push(await importOne(client, record)); }
      catch (err) {
        console.error(`[uis-import] ${record.formNo} failed:`, err.message);
        results.push({ formNo: record.formNo, action: "failed", error: err.message });
      }
    }
    console.log(`[uis-import] processed ${records.size} record(s) from ${dateFrom} to ${dateTo}`);
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
