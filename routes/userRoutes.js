const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { hikRequest } = require("../utils/helperFuntions");

// file uploads helper
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

// Register Student (direct upload approach)

router.post("/register", upload.single("faceImage"), async (req, res) => {
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
router.post(
  "/register-backup",
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
router.delete("/:employeeNo", async (req, res) => {
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

router.get("/", async (req, res) => {
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
module.exports = router;
