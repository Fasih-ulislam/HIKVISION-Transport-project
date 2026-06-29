// helperFunctions.js
//
// REFACTOR NOTE: this module no longer reads DEVICE_IP / DEVICE_USER / DEVICE_PASS
// from process.env. Every function now takes a `device` context object:
//   { ip, username, password }
// where `password` is already-decrypted plaintext, handed in by the orchestrator.
// This file has zero knowledge of encryption or Mongo — it only ever sees a
// device's connection details for the duration of a single call.

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");

// ─── Digest Auth Helper ───────────────────────────────────
function parseDigestHeader(header) {
  const params = {};
  const regex = /(\w+)="([^"]+)"/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2];
  }
  return params;
}

function buildDigestAuth(method, uri, digestParams, username, password) {
  const { realm, nonce, qop, opaque } = digestParams;
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");

  const ha1 = crypto
    .createHash("md5")
    .update(`${username}:${realm}:${password}`)
    .digest("hex");
  const ha2 = crypto.createHash("md5").update(`${method}:${uri}`).digest("hex");
  const response = crypto
    .createHash("md5")
    .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    .digest("hex");

  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"${opaque ? `, opaque="${opaque}"` : ""}`;
}

/**
 * Strips credentials out of an axios error before it's logged or returned.
 * axios error objects embed the request config (headers, auth) — without this,
 * a device password could end up in a log line or API response.
 */
function sanitizeAxiosError(err) {
  if (err?.response?.data !== undefined) {
    return err.response.data;
  }
  return err?.message || "Unknown error";
}

/**
 * @param {object} device - { ip, username, password }
 * @param {string} method
 * @param {string} endpoint
 * @param {object|null} data
 */
async function hikRequest(device, method, endpoint, data = null) {
  const { ip, username, password } = device;
  const DEVICE = `http://${ip}`;

  const separator = endpoint.includes("?") ? "&" : "?";
  const url = `${DEVICE}${endpoint}${separator}format=json`;
  const uri = new URL(url).pathname + new URL(url).search;

  try {
    // Step 1: unauthenticated request to trigger 401
    try {
      await axios({ method, url, data });
    } catch (err) {
      if (err.response?.status !== 401) {
        return { success: false, error: sanitizeAxiosError(err) };
      }

      // Step 2: parse digest challenge
      const authHeader = err.response.headers["www-authenticate"];
      if (!authHeader) {
        return { success: false, error: "No WWW-Authenticate header" };
      }

      const digestParams = parseDigestHeader(authHeader);
      const authValue = buildDigestAuth(
        method.toUpperCase(),
        uri,
        digestParams,
        username,
        password,
      );

      // Step 3: retry with auth
      try {
        const response = await axios({
          method,
          url,
          headers: {
            "Content-Type": "application/json",
            Authorization: authValue,
          },
          data,
        });
        return { success: true, data: response.data, status: response.status };
      } catch (retryErr) {
        return {
          success: false,
          error: sanitizeAxiosError(retryErr),
        };
      }
    }
  } catch (err) {
    return { success: false, error: sanitizeAxiosError(err) };
  }
}

/**
 * @param {object} device - { ip, username, password }
 * @param {string} employeeNo
 * @param {string} imagePath
 * @param {boolean} update
 */
async function uploadFaceDirect(device, employeeNo, imagePath, update = false) {
  const { ip } = device;
  const DEVICE = `http://${ip}`;

  const endpoint = "/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json";
  const url = `${DEVICE}${endpoint}`;

  const boundary = "---------------" + Date.now().toString(16);
  const imageBuffer = fs.readFileSync(imagePath);

  const jsonPayload = JSON.stringify({
    faceLibType: "blackFD",
    FDID: "1",
    FPID: employeeNo,
  });

  const jsonPart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="FaceDataRecord";\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    jsonPayload +
    `\r\n`;

  const imagePartHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="FaceImage";\r\n` +
    `Content-Type: image/jpeg\r\n\r\n`;

  const endBoundary = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(jsonPart, "utf8"),
    Buffer.from(imagePartHeader, "utf8"),
    imageBuffer,
    Buffer.from(endBoundary, "utf8"),
  ]);

  try {
    //
    // STEP 1: Get Digest Challenge
    //
    let digestHeader;

    try {
      await axios.post(url, body, {
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
      });
    } catch (err) {
      if (err.response?.status !== 401) {
        return {
          success: false,
          error: sanitizeAxiosError(err),
        };
      }

      digestHeader = err.response.headers["www-authenticate"];
    }

    if (!digestHeader) {
      return {
        success: false,
        error: "No digest challenge returned",
      };
    }

    //
    // STEP 2: Build Digest Auth
    //
    const digestParams = parseDigestHeader(digestHeader);
    const uri = new URL(url).pathname + new URL(url).search;
    const authValue = buildDigestAuth(
      "POST",
      uri,
      digestParams,
      device.username,
      device.password,
    );

    //
    // STEP 3: Authenticated Upload
    //
    const response = await axios.post(url, body, {
      headers: {
        Authorization: authValue,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        Accept: "text/html, application/xhtml+xml,",
        "Accept-Language": "en-US",
        "Cache-Control": "no-cache",
      },
      maxBodyLength: Infinity,
    });

    return {
      success: true,
      data: response.data,
    };
  } catch (err) {
    let result = null;
    if (!update) {
      result = await hikRequest(
        device,
        "PUT",
        "/ISAPI/AccessControl/UserInfo/Delete",
        {
          UserInfoDelCond: {
            EmployeeNoList: [{ employeeNo }],
          },
        },
      );
    }
    return {
      success: false,
      studentRemoved: result?.success || false,
      status: err.response?.status,
      error: sanitizeAxiosError(err),
    };
  }
}

const validateTime = (value, fieldName) => {
  // Hikvision expects exactly: YYYY-MM-DDTHH:mm:ss
  const hikTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  if (!hikTimeRegex.test(value)) {
    return `${fieldName} must be in format YYYY-MM-DDTHH:mm:ss (e.g. 2024-01-01T00:00:00)`;
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return `${fieldName} is not a valid date`;
  }
  return null;
};

// ─── Delete existing face from device ────────────────────────────────────────
/**
 * @param {object} device - { ip, username, password }
 * @param {string} employeeNo
 */
async function deleteFace(device, employeeNo) {
  return await hikRequest(
    device,
    "PUT",
    "/ISAPI/Intelligent/FDLib/FDSetUp?format=json",
    {
      faceLibType: "blackFD",
      FDID: "1",
      FPID: employeeNo,
      deleteFP: true,
    },
  );
}

function getLocalISOTime() {
  const now = new Date();
  // PKT is UTC+5, offset = 5 * 60 minutes
  const offsetMs = 5 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  return local.toISOString().slice(0, 19);
}

module.exports = {
  uploadFaceDirect,
  buildDigestAuth,
  hikRequest,
  parseDigestHeader,
  validateTime,
  deleteFace,
  getLocalISOTime,
};
