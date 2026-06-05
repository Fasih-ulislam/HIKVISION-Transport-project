const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const userController = require("../controllers/userController");
const {
  validateUser,
  compressImage,
  validateUpdate,
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

// ─── Register Student (direct upload approach) ───────────────────────────────
router.post(
  "/register",
  upload.single("faceImage"),
  compressImage,
  validateUser,
  userController.register,
);

// ─── Register Student by URL (backup) ────────────────────────────────────────
router.post(
  "/register-backup",
  upload.single("faceImage"),
  compressImage,
  userController.registerBackup,
);

// ─── Remove Student ───────────────────────────────────────────────────────────
router.delete("/:employeeNo", userController.deleteStudent);

// ─── Update Student ───────────────────────────────────────────────────────────
router.put(
  "/update/:employeeNo",
  upload.single("faceImage"),
  compressImage,
  validateUpdate,
  userController.update,
);

// ─── Get Students data ────────────────────────────────────────────────────────
router.get("/", userController.getStudents);

module.exports = router;
