const { hikRequest } = require("../utils/helperFuntions");

module.exports.healthCheck = (req, res) => {
  res.json("OK");
};

module.exports.fdlib = async (req, res) => {
  const result = await hikRequest("GET", "/ISAPI/Intelligent/FDLib");
  return res.json(result);
};

module.exports.capabilities = async (req, res) => {
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
};
module.exports.userCapabilities = async (req, res) => {
  const endpoints = [
    "/ISAPI/AccessControl/UserInfo/SetUp",
    "/ISAPI/AccessControl/UserInfo/Record/capabilities",
    "/ISAPI/AccessControl/UserInfo/Import",
    "/ISAPI/AccessControl/UserInfo/Import/capabilities",
  ];

  const results = {};
  for (const ep of endpoints) {
    const r = await hikRequest("GET", ep);
    results[ep] = r;
  }

  return res.json(results);
};

module.exports.faces = async (req, res) => {
  const result = await hikRequest("POST", "/ISAPI/Intelligent/FDLib/FDSearch", {
    searchResultPosition: 0,
    maxResults: 5,
    faceLibType: "blackFD",
    FDID: "1",
    FPID: req.params.employeeNo,
  });
  return res.json(result);
};

module.exports.fdsetup = async (req, res) => {
  const result = await hikRequest("PUT", "/ISAPI/Intelligent/FDLib/FDSetUp", {
    faceLibType: "blackFD",
    FDID: "1",
    FPID: "1",
    faceURL: "http://172.17.30.228:3000/uploads/test.jpeg",
  });

  res.json(result);
};

module.exports.securityUsers = async (req, res) => {
  const endpoints = [
    "/ISAPI/Security/users",
    "/ISAPI/Security/capabilities",
    "/ISAPI/Security/UserInfo",
  ];

  const results = {};

  for (const ep of endpoints) {
    results[ep] = await hikRequest("GET", ep);
  }

  res.json(results);
};
