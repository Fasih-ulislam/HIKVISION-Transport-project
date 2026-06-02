require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const FormData = require("form-data");

const app = express();
app.use("/uploads", express.static("uploads"));
app.use(express.json({ limit: "10mb" }));

// file uploads helper
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

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
    return {
      success: false,
      status: err.response?.status,
      error: err.response?.data || err.message,
    };
  }
}

// Register Student (direct upload approach)
app.post("/students/register", upload.single("faceImage"), async (req, res) => {
  const { employeeNo, name } = req.body;

  // create user first
  const addUser = await hikRequest(
    "POST",
    "/ISAPI/AccessControl/UserInfo/Record",
    {
      UserInfo: {
        employeeNo,
        name,
        userType: "normal",
        doorRight: "1",
        Valid: {
          enable: true,
          beginTime: "2024-01-01T00:00:00",
          endTime: "2030-12-31T23:59:59",
        },
      },
    },
  );

  if (!addUser.success) {
    fs.unlink(req.file.path, () => {});
    return res.status(500).json(addUser);
  }

  const faceResult = await uploadFaceDirect(employeeNo, req.file.path);
  fs.unlink(req.file.path, () => {});
  return res.json(faceResult);
});

// ─── Register Student by URL (backup) ───────────────────────────────────
app.post(
  "/students/register-backup",
  upload.single("faceImage"),
  async (req, res) => {
    const { employeeNo, name } = req.body;
    const file = req.file;

    if (!employeeNo || !name || !file) {
      return res
        .status(400)
        .json({ error: "employeeNo, name and faceImage are required" });
    }

    // Step A: Create user
    const addUser = await hikRequest(
      "POST",
      "/ISAPI/AccessControl/UserInfo/Record",
      {
        UserInfo: {
          employeeNo,
          name,
          userType: "normal",
          Valid: {
            enable: true,
            beginTime: "2024-01-01T00:00:00",
            endTime: "2030-12-31T23:59:59",
          },
          doorRight: "1",
          RightPlanList: { RightPlan: [{ doorNo: 1, planTemplateNo: "1" }] },
        },
      },
    );

    if (!addUser.success) {
      fs.unlink(file.path, () => {});
      return res
        .status(500)
        .json({ error: "Failed to add user", detail: addUser.error });
    }

    // Step B: Upload face — device fetches it from our server by URL
    const faceURL = `http://${process.env.SERVER_IP}:${process.env.PORT || 3000}/uploads/${file.filename}`;
    console.log();

    const addFace = await hikRequest(
      "POST",
      "/ISAPI/Intelligent/FDLib/FaceDataRecord",
      {
        faceLibType: "blackFD",
        FDID: "1",
        FPID: employeeNo,
        faceURL,
      },
    );

    fs.unlink(file.path, () => {}); // cleanup regardless of result

    if (!addFace.success) {
      return res.status(500).json({
        error: "User added but face upload failed",
        detail: addFace.error,
      });
    }

    return res.json({
      success: true,
      message: `Student ${name} registered successfully`,
    });
  },
);

// ─── 2. Remove Student ────────────────────────────────────
app.delete("/students/:employeeNo", async (req, res) => {
  const { employeeNo } = req.params;

  const result = await hikRequest(
    "PUT",
    "/ISAPI/AccessControl/UserInfo/Delete",
    {
      UserInfoDelCond: {
        EmployeeNoList: [{ employeeNo }],
      },
    },
  );

  if (!result.success) {
    return res
      .status(500)
      .json({ error: "Failed to delete user", detail: result.error });
  }

  return res.json({ success: true, message: `Student ${employeeNo} removed` });
});

app.get("/students", async (req, res) => {
  const searchID = "1";

  const position = Number(req.query.position || 0);

  const limit = Number(req.query.limit || 30);

  const result = await hikRequest(
    "POST",
    "/ISAPI/AccessControl/UserInfo/Search",
    {
      UserInfoSearchCond: {
        searchID,
        searchResultPosition: position,
        maxResults: limit,
      },
    },
  );

  if (!result.success) {
    return res.status(500).json({
      error: "Failed to fetch users",
      detail: result.error,
    });
  }

  return res.json({
    success: true,
    searchID,
    position,
    limit,
    data: result.data,
  });
});

// ─── 3. Get All Students ──────────────────────────────────

// app.get("/students", async (req, res) => {
//   const result = await hikRequest(
//     "POST",
//     "/ISAPI/AccessControl/UserInfo/Search",
//     {
//       UserInfoSearchCond: {
//         searchID: "1",
//         searchResultPosition: 0,
//         maxResults: 30,
//       },
//     },
//   );

//   if (!result.success) {
//     return res
//       .status(500)
//       .json({ error: "Failed to fetch users", detail: result.error });
//   }

//   return res.json({ success: true, data: result.data });
// });

// ─── 4. Get Access Logs ───────────────────────────────────
app.get("/logs", async (req, res) => {
  const start = req.query.start || "2026-05-1";
  const end = req.query.end || "2026-12-31";

  const result = await hikRequest(
    "POST",
    "/ISAPI/AccessControl/AcsEvent",

    // {
    //   AcsEventCond: {
    //     searchID: "1",
    //     searchResultPosition: 0,
    //     maxResults: 30,
    //     major: 5,
    //     minor: 75,
    //   },
    // },

    {
      AcsEventCond: {
        searchID: "session_99",
        searchResultPosition: 0,
        maxResults: 10,
        major: 5,
        minor: 0,
        timeReverseOrder: true,
        doorNo: 1,
      },
    },
  );

  if (!result.success) {
    return res
      .status(500)
      .json({ error: "Failed to fetch logs", detail: result.error });
  }

  return res.json({ success: true, data: result.data });
});

// debugging routes
app.get("/debug/fdlib", async (req, res) => {
  const result = await hikRequest("GET", "/ISAPI/Intelligent/FDLib");
  return res.json(result);
});

app.get("/debug/capabilities", async (req, res) => {
  const endpoints = [
    "/ISAPI/AccessControl/Face/Record",
    "/ISAPI/AccessControl/FaceDataRecord",
    "/ISAPI/AccessControl/Face/1/FaceDataRecord",
    "/ISAPI/AccessControl/UserInfo/capabilities",
    "/ISAPI/AccessControl/capabilities",
  ];

  const results = {};
  for (const ep of endpoints) {
    const r = await hikRequest("GET", ep);
    results[ep] = r;
  }

  return res.json(results);
});

app.get("/debug/faces/:employeeNo", async (req, res) => {
  const result = await hikRequest("POST", "/ISAPI/Intelligent/FDLib/FDSearch", {
    searchResultPosition: 0,
    maxResults: 5,
    faceLibType: "blackFD",
    FDID: "1",
    FPID: req.params.employeeNo,
  });
  return res.json(result);
});

app.get("/debug/fdsetup", async (req, res) => {
  const result = await hikRequest("GET", "/ISAPI/Intelligent/FDLib/FDSetUp");

  res.json(result);
});

// ─── Start ────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on http://localhost:${process.env.PORT || 3000}`);
});
