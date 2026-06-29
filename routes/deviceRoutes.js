// routes/deviceRoutes.js
const express = require("express");
const router = express.Router();
const deviceController = require("../controllers/deviceController");

// ─── Register a new device ────────────────────────────────────────────────────
router.post("/", deviceController.registerDevice);

// ─── List all devices (no credentials returned) ───────────────────────────────
router.get("/", deviceController.listDevices);

// ─── Enable/disable a device ───────────────────────────────────────────────────
router.patch("/:id/status", deviceController.setDeviceStatus);

// ─── Remove a device ───────────────────────────────────────────────────────────
router.delete("/:id", deviceController.deleteDevice);

module.exports = router;
