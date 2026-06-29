// services/alertStream.js
require("dotenv").config();
const axios = require("axios");
const HikDevice = require("../models/HikDevice");
const DeviceLog = require("../models/deviceLogsModel");
const { decryptPassword } = require("../utils/crypto");
const {
  parseDigestHeader,
  buildDigestAuth,
} = require("../utils/helperFuntions");

const ENDPOINT = "/ISAPI/Event/notification/alertStream";

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
function normalizeEvent(event, deviceId) {
  // Stream sends generic notification — access control events
  // come through with eventType like "accessControllerEvent"
  // and carry a nested AccessControllerEvent object
  const ac = event.AccessControllerEvent || {};

  return {
    deviceId,
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

async function saveEvent(event, deviceId, deviceLabel) {
  // Skip non-access-control events (videoloss, etc.)
  if (!event.AccessControllerEvent) {
    return; // silent skip, no need to log these
  }

  const normalized = normalizeEvent(event, deviceId);

  if (normalized.major === null || normalized.minor === null) {
    console.log(
      `[AlertStream:${deviceLabel}] Missing major/minor, raw:`,
      JSON.stringify(event),
    );
    return;
  }

  try {
    const log = new DeviceLog(normalized);
    await log.save();
    console.log(
      `[AlertStream:${deviceLabel}] Saved: ${normalized.eventType} — serialNo: ${normalized.serialNo} — name: ${normalized.name}`,
    );
  } catch (err) {
    // E11000 here means this exact (deviceId, serialNo) pair was already
    // saved — a genuine duplicate delivery from this same device, safe
    // to skip. Because the index is now compound, this can no longer be
    // mistaken for the same serialNo arriving from a *different* device.
    if (err.code === 11000) return;
    console.error(
      `[AlertStream:${deviceLabel}] Failed to save event:`,
      err.message,
    );
  }
}

async function getDigestAuth(streamUrl, endpoint, username, password) {
  try {
    await axios.get(streamUrl);
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    const digestParams = parseDigestHeader(
      err.response.headers["www-authenticate"],
    );
    return buildDigestAuth("GET", endpoint, digestParams, username, password);
  }
}

/**
 * Manages exactly one device's alert stream connection: connect, consume,
 * reconnect on drop. Fully isolated from every other device's instance —
 * its own buffer, its own running flag, its own reconnect timer. One
 * device's stream dying never touches another device's connection.
 */
class DeviceAlertStream {
  constructor(deviceDoc) {
    this.deviceId = String(deviceDoc._id);
    this.ip = deviceDoc.ip;
    this.username = deviceDoc.username;
    // Decrypted once per stream lifetime, kept only on this instance —
    // not in any shared/module-level map. Falls out of scope if this
    // instance is stopped and not restarted.
    this.password = decryptPassword(deviceDoc.passwordEnc);
    this.label = deviceDoc.name || this.ip;

    this.streamUrl = `http://${this.ip}${ENDPOINT}`;
    this.isRunning = false;
    this.stopped = false; // set true by stop(); prevents reconnect after explicit stop
    this.buffer = "";
    this.reconnectTimer = null;
    this.request = null; // current axios stream response, if connected
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stopped = false;

    console.log(`[AlertStream:${this.label}] Connecting...`);

    try {
      const authValue = await getDigestAuth(
        this.streamUrl,
        ENDPOINT,
        this.username,
        this.password,
      );

      const response = await axios.get(this.streamUrl, {
        headers: {
          Authorization: authValue,
          Accept: "multipart/x-mixed-replace",
        },
        responseType: "stream",
        timeout: 0,
      });

      console.log(`[AlertStream:${this.label}] Connected`);
      this.request = response.data;
      this.buffer = "";

      response.data.on("data", (chunk) => this._onData(chunk));
      response.data.on("end", () => this._onEnd());
      response.data.on("error", (err) => this._onError(err));
    } catch (err) {
      console.error(
        `[AlertStream:${this.label}] Connection failed:`,
        err.message,
      );
      this.isRunning = false;
      this._scheduleReconnect();
    }
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf8");

    const parts = this.buffer.split("--MIME_boundary");
    this.buffer = parts.pop(); // keep incomplete last chunk

    for (const part of parts) {
      const event = parseChunk(part);
      if (event) saveEvent(event, this.deviceId, this.label);
    }
  }

  _onEnd() {
    console.log(
      `[AlertStream:${this.label}] Stream ended — reconnecting in 5s`,
    );
    this.isRunning = false;
    this._scheduleReconnect();
  }

  _onError(err) {
    console.error(`[AlertStream:${this.label}] Stream error:`, err.message);
    this.isRunning = false;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start(), 5000);
  }

  /**
   * Stops this device's stream and cancels any pending reconnect.
   * Use when a device is deactivated/removed without restarting the
   * whole process.
   */
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.request) {
      this.request.destroy();
      this.request = null;
    }
    this.isRunning = false;
  }
}

// One DeviceAlertStream instance per device, keyed by deviceId string.
// This map only ever holds the live instances — each instance privately
// owns its own decrypted password; nothing here stores credentials
// directly.
const activeStreams = new Map();

/**
 * Starts (or restarts) the alert stream for every active device.
 * Devices already streaming are left alone; new devices get a fresh
 * DeviceAlertStream. Call this once at boot, and again any time the
 * device list changes (e.g. after adding a device) if you want it
 * picked up without a process restart.
 *
 * @param {object} [filter] - optional Mongo filter, defaults to active-only
 */
async function startAlertStreams(filter = { status: "active" }) {
  const devices = await HikDevice.find(filter).lean();

  for (const deviceDoc of devices) {
    const deviceId = String(deviceDoc._id);
    if (activeStreams.has(deviceId)) continue; // already running

    const stream = new DeviceAlertStream(deviceDoc);
    activeStreams.set(deviceId, stream);
    stream.start(); // fire and forget — internal reconnect loop handles failures
  }
}

/**
 * Stops the stream for a single device and removes it from the active
 * set, e.g. when a device is deactivated.
 */
function stopAlertStream(deviceId) {
  const id = String(deviceId);
  const stream = activeStreams.get(id);
  if (!stream) return;
  stream.stop();
  activeStreams.delete(id);
}

/** Stops every active device stream. Useful for graceful shutdown. */
function stopAllAlertStreams() {
  for (const id of activeStreams.keys()) {
    stopAlertStream(id);
  }
}

module.exports = {
  startAlertStreams,
  stopAlertStream,
  stopAllAlertStreams,
};
