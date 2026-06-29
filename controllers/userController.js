// controllers/userController.js
//
// REFACTOR NOTE: these functions are no longer Express (req, res) handlers.
// Each one now takes (device, req) and returns a plain result object:
//   { success: true/false, ...data }
// The orchestrator is responsible for calling these once per device (via
// Promise.allSettled) and for writing the aggregated response to `res`.
// Nothing in this file writes to `res` or knows that other devices exist.

const path = require("path");
const fs = require("fs");
require("dotenv").config();
const {
  hikRequest,
  uploadFaceDirect,
  validateTime,
  deleteFace,
} = require("../utils/helperFuntions");

/**
 * @param {object} device - { ip, username, password, deviceId? }
 * @param {object} req - the original Express req (file, body, params, query)
 * @returns {Promise<object>} result object, never writes to res
 */
module.exports.register = async (device, req) => {
  const file = req.file;
  try {
    const { employeeNo, name, userType, beginTime, endTime } = req.body || {};

    const addUser = await hikRequest(
      device,
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
      return { success: false, status: 500, ...addUser };
    }

    const faceResult = await uploadFaceDirect(device, employeeNo, file.path);
    return { status: faceResult.success ? 200 : 500, ...faceResult };
  } finally {
    if (file) fs.unlink(file.path, () => {});
  }
};

// Register Backup (uses URL for images rather than direct upload)
/**
 * @param {object} device - { ip, username, password, deviceId? }
 * @param {object} req
 */
module.exports.registerBackup = async (device, req) => {
  const { employeeNo, name } = req.body;
  const file = req.file;

  if (!employeeNo || !name || !file) {
    return {
      success: false,
      status: 400,
      error: "employeeNo, name and faceImage are required",
    };
  }

  // Step A: Create user
  const addUser = await hikRequest(
    device,
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
    return {
      success: false,
      status: 500,
      error: "Failed to add user",
      detail: addUser.error,
    };
  }

  // Step B: Upload face — device fetches it from our server by URL
  const faceURL = `http://${process.env.SERVER_IP}:${process.env.PORT || 3000}/uploads/${file.filename}`;

  const addFace = await hikRequest(
    device,
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
    return {
      success: false,
      status: 500,
      error: "User added but face upload failed",
      detail: addFace.error,
    };
  }

  return {
    success: true,
    status: 200,
    message: `Student ${name} registered successfully`,
  };
};

/**
 * @param {object} device
 * @param {object} req
 */
module.exports.deleteStudent = async (device, req) => {
  const { employeeNo } = req.params;

  // Fetch current user info first to fill in unchanged fields
  const currentUser = await hikRequest(
    device,
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
    return { success: false, status: 404, error: "User not found on device" };
  }

  const result = await hikRequest(
    device,
    "PUT",
    "/ISAPI/AccessControl/UserInfo/Delete",
    {
      UserInfoDelCond: {
        EmployeeNoList: [{ employeeNo }],
      },
    },
  );

  if (!result.success) {
    return {
      success: false,
      status: 500,
      error: "Failed to delete user",
      detail: result.error,
    };
  }

  return {
    success: true,
    status: 200,
    message: `Student ${employeeNo} removed`,
  };
};

/**
 * @param {object} device
 * @param {object} req
 */
module.exports.getStudents = async (device, req) => {
  const searchID = "1";
  const position = Number(req.query.position || 0);
  const limit = Number(req.query.limit || 30);

  const result = await hikRequest(
    device,
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
    return {
      success: false,
      status: 500,
      error: "Failed to fetch users",
      detail: result.error,
    };
  }

  return {
    success: true,
    status: 200,
    searchID,
    position,
    limit,
    data: result.data,
  };
};

/**
 * @param {object} device
 * @param {object} req
 */
module.exports.update = async (device, req) => {
  const file = req.file;
  try {
    const { employeeNo } = req.params;
    const { userType, beginTime, endTime, name } = req.body || {};

    // ─── Update user info (only if any of these fields are passed) ──────────────
    if (userType || beginTime || endTime || name) {
      const currentUser = await hikRequest(
        device,
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
        return {
          success: false,
          status: 404,
          error: "User not found on device",
        };
      }

      const existing = currentUser.data.UserInfoSearch.UserInfo[0];

      const updateResult = await hikRequest(
        device,
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
        return { success: false, status: 500, ...updateResult };
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
        return {
          success: false,
          status: 400,
          error: "Image must be a JPEG/JPG and less than 200 KB",
        };
      }

      const deleted = await deleteFace(device, employeeNo);
      if (!deleted.success) {
        console.log(deleted);
      }

      const faceResult = await uploadFaceDirect(
        device,
        employeeNo,
        file.path,
        true,
      );

      if (!faceResult.success) {
        return { success: false, status: 500, ...faceResult };
      }
    }

    return { success: true, status: 200, message: "User updated successfully" };
  } finally {
    if (file) fs.unlink(file.path, () => {});
  }
};

/**
 * @param {object} device
 * @param {object} req
 */
module.exports.getStudent = async (device, req) => {
  const { employeeNo } = req.params;
  const result = await hikRequest(
    device,
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
  return result;
};
