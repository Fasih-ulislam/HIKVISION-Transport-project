const express = require("express");
const router = express.Router();
const loggingController = require("../controllers/loggingController");

router.get("/device", loggingController.deviceLogs);

module.exports = router;
