require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");

const DEVICE = `http://${process.env.DEVICE_IP}`;
const USERNAME = process.env.DEVICE_USER;
const PASSWORD = process.env.DEVICE_PASS;

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

function buildDigestAuth(method, uri, digestParams) {
  const { realm, nonce, qop, opaque } = digestParams;
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");

  const ha1 = crypto
    .createHash("md5")
    .update(`${USERNAME}:${realm}:${PASSWORD}`)
    .digest("hex");
  const ha2 = crypto.createHash("md5").update(`${method}:${uri}`).digest("hex");
  const response = crypto
    .createHash("md5")
    .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    .digest("hex");

  return `Digest username="${USERNAME}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"${opaque ? `, opaque="${opaque}"` : ""}`;
}

async function hikRequest(method, endpoint, data = null) {
  const separator = endpoint.includes("?") ? "&" : "?";
  const url = `${DEVICE}${endpoint}${separator}format=json`;
  const uri = new URL(url).pathname + new URL(url).search;

  try {
    // Step 1: unauthenticated request to trigger 401
    try {
      await axios({ method, url, data });
    } catch (err) {
      if (err.response?.status !== 401) {
        return { success: false, error: err.response?.data || err.message };
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
          error: retryErr.response?.data || retryErr.message,
        };
      }
    }
  } catch (err) {
    return { success: false, error: err.response?.data || err.message };
  }
}

// direct face upload helper
async function uploadFaceDirect(employeeNo, imagePath) {
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
          error: err.response?.data || err.message,
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

    const authValue = buildDigestAuth("POST", uri, digestParams);

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
    const result = await hikRequest(
      "PUT",
      "/ISAPI/AccessControl/UserInfo/Delete",
      {
        UserInfoDelCond: {
          EmployeeNoList: [{ employeeNo }],
        },
      },
    );
    return {
      success: false,
      studentRemoved: result.success,
      status: err.response?.status,
      error: err.response?.data || err.message,
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

module.exports = {
  uploadFaceDirect,
  buildDigestAuth,
  hikRequest,
  parseDigestHeader,
  validateTime,
};
