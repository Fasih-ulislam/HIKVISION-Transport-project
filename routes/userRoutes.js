const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const userController = require("../controllers/userController");
const {
  validateUser,
  decodeBase64Image,
  validateUpdate,
} = require("../middlewares/helperMiddlewares");

// file uploads helper
// const storage = multer.diskStorage({
//   destination: "uploads/",
//   filename: (req, file, cb) => {
//     const ext = path.extname(file.originalname);
//     cb(null, `${Date.now()}${ext}`);
//   },
// });
// const upload = multer({ storage });

// ─── Register Student (direct upload approach) ───────────────────────────────
router.post(
  "/register",
  decodeBase64Image,
  validateUser,
  userController.register,
);

// // ─── Register Student by URL (backup) ────────────────────────────────────────
// router.post(
//   "/register-backup",
//   upload.single("faceImage"),
//   decodeBase64Image,
//   userController.registerBackup,
// );

// ─── Remove Student ───────────────────────────────────────────────────────────
router.delete("/:employeeNo", userController.deleteStudent);

// ─── Update Student ───────────────────────────────────────────────────────────
router.put(
  "/update/:employeeNo",
  decodeBase64Image,
  validateUpdate,
  userController.update,
);

// ─── Get Students data ────────────────────────────────────────────────────────
router.get("/", userController.getStudents);

// Get Student by ID
router.get("/:employeeNo", userController.getStudent);

module.exports = router;
