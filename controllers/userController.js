const path = require("path");
const fs = require("fs");
require("dotenv").config();
const {
  hikRequest,
  uploadFaceDirect,
  validateTime,
  deleteFace,
} = require("../utils/helperFuntions");

module.exports.register = async (req, res) => {
  const file = req.file;
  try {
    const { employeeNo, name, userType, beginTime, endTime } = req.body || {};

    const addUser = await hikRequest(
      "POST",
      "/ISAPI/AccessControl/UserInfo/Record",
      {
        UserInfo: {
          employeeNo,
          name,
          userType: userType || "normal",
          doorRight: "1",
          Valid: {
            enable: true,
            beginTime,
            endTime,
          },
          RightPlan: [
            {
              doorNo: 1,
              planTemplateNo: "1",
            },
          ],
        },
      },
    );

    if (!addUser.success) {
      return res.status(500).json(addUser);
    }

    const faceResult = await uploadFaceDirect(employeeNo, file.path);
    return res.json(faceResult);
  } finally {
    if (file) fs.unlink(file.path, () => {});
  }
};

// Register Backup (uses URL for images rather than direct upload)
module.exports.registerBackup = async (req, res) => {
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
};
module.exports.deleteStudent = async (req, res) => {
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
};

//get Students
module.exports.getStudents = async (req, res) => {
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
};

// Update Student
module.exports.update = async (req, res) => {
  const file = req.file;
  try {
    const { employeeNo } = req.params;

    const { userType, beginTime, endTime, name } = req.body || {};

    // ─── Update user info (only if any of these fields are passed) ──────────────
    if (userType || beginTime || endTime || name) {
      // Fetch current user info first to fill in unchanged fields
      const currentUser = await hikRequest(
        "POST",
        "/ISAPI/AccessControl/UserInfo/Search?format=json",
        {
          UserInfoSearchCond: {
            searchID: "1",
            searchResultPosition: 0,
            maxResults: 1,
            EmployeeNoList: [{ employeeNo }],
          },
        },
      );

      if (
        !currentUser.success ||
        !currentUser.data?.UserInfoSearch?.UserInfo?.[0]
      ) {
        return res.status(404).json({ error: "User not found on device" });
      }

      const existing = currentUser.data.UserInfoSearch.UserInfo[0];

      const updateResult = await hikRequest(
        "PUT",
        "/ISAPI/AccessControl/UserInfo/Modify?format=json",
        {
          UserInfo: {
            employeeNo,
            name: name || existing.name,
            userType: userType || existing.userType,
            doorRight: existing.doorRight || "1",
            Valid: {
              enable: true,
              beginTime: beginTime || existing.Valid?.beginTime,
              endTime: endTime || existing.Valid?.endTime,
            },
          },
        },
      );

      if (!updateResult.success) {
        return res.status(500).json(updateResult);
      }
    }

    // ─── Update face image (only if file was passed) ─────────────────────────────
    if (file) {
      const allowedMimeTypes = ["image/jpeg", "image/jpg"];
      const maxSizeBytes = 200 * 1024;

      if (
        !allowedMimeTypes.includes(file.mimetype) ||
        file.size > maxSizeBytes
      ) {
        return res
          .status(400)
          .json({ error: "Image must be a JPEG/JPG and less than 200 KB" });
      }

      const deleted = await deleteFace(employeeNo);
      if (!deleted.success) {
        console.log(deleted);
      }

      const faceResult = await uploadFaceDirect(employeeNo, file.path, true);

      if (!faceResult.success) {
        return res.status(500).json(faceResult);
      }
    }

    return res.json({ success: true, message: "User updated successfully" });
  } finally {
    if (file) fs.unlink(file.path, () => {});
  }
};

module.exports.getStudent = async (req, res) => {
  const { employeeNo } = req.params;
  const result = await hikRequest(
    "POST",
    "/ISAPI/AccessControl/UserInfo/Search?format=json",
    {
      UserInfoSearchCond: {
        searchID: "1",
        searchResultPosition: 0,
        maxResults: 1,
        EmployeeNoList: [{ employeeNo }],
      },
    },
  );
  return res.json(result);
};
