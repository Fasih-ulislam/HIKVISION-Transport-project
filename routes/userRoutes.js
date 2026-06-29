// routes/userRoutes.js

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const userController = require("../controllers/userController");
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

// Small wrapper so each route stays a one-liner: runs `fn` across every
// active device and sends back the aggregated { summary, results } shape.
function fanOut(fn) {
  return async (req, res) => {
    const { summary, results } = await runAcrossDevices(fn, req);
    return res.json({ summary, results });
  };
}

// ─── Register Student (direct upload approach) ───────────────────────────────
router.post(
  "/register",
  decodeBase64Image,
  validateUser,
  fanOut(userController.register),
);

// ─── Register Student by Image direct (backup) ────────────────────────────────────────
router.post(
  "/register-backup-v1",
  upload.single("faceImage"),
  compressImage,
  validateUser,
  fanOut(userController.register),
);

// // ─── Register Student by URL (backup) ────────────────────────────────────────
// router.post(
//   "/register-backup-v2",
//   upload.single("faceImage"),
//   decodeBase64Image,
//   fanOut(userController.registerBackup),
// );

// ─── Remove Student ───────────────────────────────────────────────────────────
router.delete("/:employeeNo", fanOut(userController.deleteStudent));

// ─── Update Student ───────────────────────────────────────────────────────────
router.put(
  "/update/:employeeNo",
  decodeBase64Image,
  validateUpdate,
  fanOut(userController.update),
);

// ─── Get Students data ────────────────────────────────────────────────────────
router.get("/", fanOut(userController.getStudents));

// Get Student by ID
router.get("/:employeeNo", fanOut(userController.getStudent));

module.exports = router;
