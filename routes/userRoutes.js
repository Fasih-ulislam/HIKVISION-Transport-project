const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const userController = require("../controllers/userController");

// file uploads helper
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

// Register Student (direct upload approach)

router.post("/register", upload.single("faceImage"), userController.register);

// ─── Register Student by URL (backup) ───────────────────────────────────
router.post(
  "/register-backup",
  upload.single("faceImage"),
  userController.registerBackup,
);

// ─── 2. Remove Student ────────────────────────────────────
router.delete("/:employeeNo", userController.deleteStudent);

// Get Students data
router.get("/", userController.getStudents);
module.exports = router;
