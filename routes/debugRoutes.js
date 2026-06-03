const express = require("express");
const router = express.Router();
const { hikRequest } = require("../utils/helperFuntions");

// debugging routes
router.get("/health-check", (req, res) => {
  res.json("OK");
});

router.get("/fdlib", async (req, res) => {
  const result = await hikRequest("GET", "/ISAPI/Intelligent/FDLib");
  return res.json(result);
});

router.get("/capabilities", async (req, res) => {
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

router.get("/faces/:employeeNo", async (req, res) => {
  const result = await hikRequest("POST", "/ISAPI/Intelligent/FDLib/FDSearch", {
    searchResultPosition: 0,
    maxResults: 5,
    faceLibType: "blackFD",
    FDID: "1",
    FPID: req.params.employeeNo,
  });
  return res.json(result);
});

router.get("/fdsetup", async (req, res) => {
  const result = await hikRequest("GET", "/ISAPI/Intelligent/FDLib/FDSetUp");

  res.json(result);
});

module.exports = router;
