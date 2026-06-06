// services/alertStream.js
require("dotenv").config();
const axios = require("axios");
const DeviceLog = require("../models/deviceLogsModel");
const {
  parseDigestHeader,
  buildDigestAuth,
} = require("../utils/helperFuntions");

const DEVICE = `http://${process.env.DEVICE_IP}`;
const ENDPOINT = "/ISAPI/Event/notification/alertStream";
const STREAM_URL = `${DEVICE}${ENDPOINT}`;

// Based on real data from your device logs
const MINOR_EVENT_MAP = {
  75: "face_verified",
  6: "blacklist_detected",
  21: "door_opened",
  22: "door_closed",
  104: "duplicate_scan",
};

function parseEventType(minor) {
  return MINOR_EVENT_MAP[minor] || `unknown_${minor}`;
}

function parseChunk(raw) {
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;

  try {
    return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }
}

// Map the alert stream event format to our DB schema
// The stream uses different field names than AcsEvent polling
function normalizeEvent(event) {
  // Stream sends generic notification — access control events
  // come through with eventType like "accessControllerEvent"
  // and carry a nested AccessControllerEvent object
  const ac = event.AccessControllerEvent || {};

  return {
    major: ac.majorEventType ?? null,
    minor: ac.subEventType ?? null,
    eventType: parseEventType(ac.subEventType),
    time: event.dateTime ? new Date(event.dateTime) : new Date(),
    employeeNoString: ac.employeeNoString ?? null,
    name: ac.name ?? null,
    userType: ac.userType ?? null,
    doorNo: ac.doorNo ? parseInt(ac.doorNo) : null,
    cardType: ac.cardType ? parseInt(ac.cardType) : null,
    cardReaderNo: ac.cardReaderNo ? parseInt(ac.cardReaderNo) : null,
    serialNo: ac.serialNo ? parseInt(ac.serialNo) : null,
    currentVerifyMode: ac.currentVerifyMode ?? null,
    attendanceStatus: ac.attendanceStatus ?? null,
    mask: ac.mask ?? null,
    pictureURL: ac.pictureURL ?? null,
    picturesNumber: ac.picturesNumber ? parseInt(ac.picturesNumber) : null,
    raw: event,
  };
}

async function saveEvent(event) {
  // Skip non-access-control events (videoloss, etc.)
  if (!event.AccessControllerEvent) {
    return; // silent skip, no need to log these
  }

  const normalized = normalizeEvent(event);

  if (normalized.major === null || normalized.minor === null) {
    console.log(
      "[AlertStream] Missing major/minor, raw:",
      JSON.stringify(event),
    );
    return;
  }

  try {
    const log = new DeviceLog(normalized);
    await log.save();
    console.log(
      `[AlertStream] Saved: ${normalized.eventType} — serialNo: ${normalized.serialNo} — name: ${normalized.name}`,
    );
  } catch (err) {
    if (err.code === 11000) return;
    console.error("[AlertStream] Failed to save event:", err.message);
  }
}

async function getDigestAuth() {
  try {
    await axios.get(STREAM_URL);
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    const digestParams = parseDigestHeader(
      err.response.headers["www-authenticate"],
    );
    return buildDigestAuth("GET", ENDPOINT, digestParams);
  }
}

let isRunning = false;

async function startAlertStream() {
  if (isRunning) return;
  isRunning = true;

  console.log("[AlertStream] Connecting...");

  try {
    const authValue = await getDigestAuth();

    const response = await axios.get(STREAM_URL, {
      headers: {
        Authorization: authValue,
        Accept: "multipart/x-mixed-replace",
      },
      responseType: "stream",
      timeout: 0,
    });

    console.log("[AlertStream] Connected");

    let buffer = "";

    response.data.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      const parts = buffer.split("--MIME_boundary");
      buffer = parts.pop(); // keep incomplete last chunk

      for (const part of parts) {
        const event = parseChunk(part);
        if (event) saveEvent(event);
      }
    });

    response.data.on("end", () => {
      console.log("[AlertStream] Stream ended — reconnecting in 5s");
      isRunning = false;
      setTimeout(startAlertStream, 5000);
    });

    response.data.on("error", (err) => {
      console.error("[AlertStream] Stream error:", err.message);
      isRunning = false;
      setTimeout(startAlertStream, 5000);
    });
  } catch (err) {
    console.error("[AlertStream] Connection failed:", err.message);
    isRunning = false;
    setTimeout(startAlertStream, 5000);
  }
}

module.exports = { startAlertStream };
