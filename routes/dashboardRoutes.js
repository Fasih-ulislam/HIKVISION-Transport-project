const express = require("express");
const controller = require("../controllers/dashboardController");
const router = express.Router();

router.get("/overview", controller.overview);
router.get("/device-events", controller.deviceEvents);
router.get("/request-logs", controller.requestLogs);

module.exports = router;
