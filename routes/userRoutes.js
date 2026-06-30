// routes/userRoutes.js

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const userController = require("../controllers/userController");
const userSyncService = require("../services/userSyncService");
const { runAcrossDevices } = require("../utils/orchestrator");
const {
  validateUser,
  decodeBase64Image,
  validateUpdate,
  compressImage,
} = require("../middlewares/helperMiddlewares");

// file uploads helper
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

// Small wrapper so device-direct routes stay one-liners: runs `fn` across
// every active device and sends back the aggregated { summary, results }
// shape. Used ONLY for routes that intentionally bypass the User/
// DeviceUserSync layer (the device-direct read routes below) — register/
// update/delete go through userSyncService instead, since those need the
// version bump + sync-table bookkeeping that fanOut alone doesn't do.
function fanOut(fn) {
  return async (req, res) => {
    const { summary, results } = await runAcrossDevices(fn, req);
    return res.json({ summary, results });
  };
}

// Wrapper for routes backed by userSyncService. Centralizes the
// try/catch and the err.status convention (thrown by the service layer
// for things like "user not found") so each route stays a one-liner and
// errors come back as proper HTTP status codes instead of all falling
// through as generic 500s.
function viaService(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      return res.json(result);
    } catch (err) {
      const status = err.status || 500;
      return res
        .status(status)
        .json({ error: err.message || "Unexpected error" });
    }
  };
}

// ─── Register Student (direct upload approach) ───────────────────────────────
router.post(
  "/register",
  decodeBase64Image,
  validateUser,
  viaService(userSyncService.registerUser),
);

// ─── Register Student by Image direct (backup) ────────────────────────────────────────
router.post(
  "/register-backup-v1",
  upload.single("faceImage"),
  compressImage,
  validateUser,
  viaService(userSyncService.registerUser),
);

// // ─── Register Student by URL (backup) ────────────────────────────────────────
// // registerBackup is not currently wired into the User/DeviceUserSync
// // flow — out of scope for now, left commented as in the original file.
// router.post(
//   "/register-backup-v2",
//   upload.single("faceImage"),
//   decodeBase64Image,
//   fanOut(userController.registerBackup),
// );

// ─── Remove Student ───────────────────────────────────────────────────────────
// Goes through userSyncService.deleteUser, which checks the User exists
// in our DB BEFORE fanning out to any device — a delete for an
// employeeNo we have no record of fails fast with 404 instead of making
// a live HTTP call to every device only to have each one independently
// 404. The existing per-device "does this device actually have this
// user" check inside userController.deleteStudent is unchanged and
// still runs per-device — that one is still necessary, since a single
// device can independently be missing the user even when our DB says
// it should have it.
router.delete("/:employeeNo", viaService(userSyncService.deleteUser));

// ─── Update Student ───────────────────────────────────────────────────────────
router.put(
  "/update/:employeeNo",
  decodeBase64Image,
  validateUpdate,
  viaService(userSyncService.updateUser),
);

// ─── Get Students data (device-direct) ────────────────────────────────────────
// Reads straight from a device's own UserInfo/Search, bypassing User/
// DeviceUserSync entirely. Kept as its own independent route rather than
// merged with the DB-backed read below — these answer different
// questions ("what does this specific device currently have" vs "what
// does our system believe is true"), and conflating them would make it
// impossible to ever debug a device that's drifted from our records.
router.get("/", fanOut(userController.getStudents));

// Get Student by ID (device-direct)
router.get("/:employeeNo", fanOut(userController.getStudent));

// ─── Get Students data (DB-backed) ────────────────────────────────────────────
// Reads from our own User collection — fast, no device round-trip, and
// reflects what we believe the canonical state to be regardless of
// whether every device has actually caught up yet.
router.get("/db/all", async (req, res) => {
  try {
    const User = require("../models/User");
    const users = await User.find({ status: "active" }).lean();
    return res.json({ total: users.length, users });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Get Student by ID (DB-backed)
router.get("/db/:employeeNo", async (req, res) => {
  try {
    const User = require("../models/User");
    const user = await User.findOne({
      employeeNo: req.params.employeeNo,
      status: "active",
    }).lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ user });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
