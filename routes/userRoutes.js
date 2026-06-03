const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const sharp = require("sharp");
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

// ─── Image compression middleware ────────────────────────────────────────────
const compressImage = async (req, res, next) => {
  if (!req.file) return next();

  const filePath = req.file.path;
  const targetSizeKB = 200;
  const targetSizeBytes = targetSizeKB * 1024;

  try {
    // Check if compression is even needed
    const { size: originalSize } = fs.statSync(filePath);
    if (originalSize <= targetSizeBytes) return next();

    // Read original into buffer
    const inputBuffer = fs.readFileSync(filePath);

    // Start at quality 80, step down by 10 until under 200 KB
    let quality = 80;
    let outputBuffer;

    while (quality >= 10) {
      outputBuffer = await sharp(inputBuffer)
        .jpeg({ quality }) // convert to JPEG regardless of original format
        .toBuffer();

      if (outputBuffer.length <= targetSizeBytes) break;
      quality -= 10;
    }

    // Write compressed image back to the same path (overwrite)
    fs.writeFileSync(filePath, outputBuffer);

    // Update req.file metadata to reflect the new state
    req.file.size = outputBuffer.length;
    req.file.mimetype = "image/jpeg";
    req.file.filename =
      path.basename(filePath, path.extname(filePath)) + ".jpg";
    req.file.path = filePath;

    console.log(
      `Image compressed: ${(originalSize / 1024).toFixed(1)} KB → ${(outputBuffer.length / 1024).toFixed(1)} KB (quality: ${quality})`,
    );

    next();
  } catch (err) {
    console.error("Image compression failed:", err);
    return res
      .status(500)
      .json({ message: "Image compression failed", error: err.message });
  }
};

// ─── Register Student (direct upload approach) ───────────────────────────────
router.post(
  "/register",
  upload.single("faceImage"),
  compressImage,
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

// ─── Get Students data ────────────────────────────────────────────────────────
router.get("/", userController.getStudents);

module.exports = router;
