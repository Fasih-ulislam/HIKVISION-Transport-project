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
  const result = await hikRequest("GET", "/ISAPI/Intelligent/FDLib/FDSetUp");

  res.json(result);
};
