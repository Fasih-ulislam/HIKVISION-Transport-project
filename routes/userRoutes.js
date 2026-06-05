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
  const targetSizeBytes = 200 * 1024;

  try {
    const { size: originalSize } = fs.statSync(filePath);
    const inputBuffer = fs.readFileSync(filePath);
    const metadata = await sharp(inputBuffer).metadata();

    // If size is under 200KB but NOT a jpeg/jpg, convert it right now
    if (originalSize <= targetSizeBytes) {
      if (metadata.format !== "jpeg" && metadata.format !== "jpg") {
        const convertedBuffer = await sharp(inputBuffer)
          .rotate() // Keeps orientation correct
          .jpeg({ quality: 90 }) // High quality since size isn't an issue
          .toBuffer();

        fs.writeFileSync(filePath, convertedBuffer);

        req.file.size = convertedBuffer.length;
        req.file.mimetype = "image/jpeg";
        req.file.filename =
          path.basename(filePath, path.extname(filePath)) + ".jpg";
      }
      return next(); // If it was already a JPEG and under 200KB, it just flows through here
    }

    // Let's keep your original logic going for images > 200KB
    let outputBuffer;
    let usedWidth = metadata.width;
    let usedQuality = 80;

    // Strategy: shrink width in steps (keeping aspect ratio), then try quality reduction
    const widthSteps = [1200, 1000, 800, 600, 400];

    outer: for (const width of widthSteps) {
      if (width >= metadata.width) continue; // no point upscaling

      for (let quality = 80; quality >= 40; quality -= 10) {
        outputBuffer = await sharp(inputBuffer)
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .jpeg({ quality, mozjpeg: false })
          .toBuffer();

        if (outputBuffer.length <= targetSizeBytes) {
          usedWidth = width;
          usedQuality = quality;
          break outer;
        }
      }
    }

    // Last resort: if still too big after all steps
    if (!outputBuffer || outputBuffer.length > targetSizeBytes) {
      outputBuffer = await sharp(inputBuffer)
        .rotate()
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg({ quality: 40 })
        .toBuffer();
    }

    fs.writeFileSync(filePath, outputBuffer);

    req.file.size = outputBuffer.length;
    req.file.mimetype = "image/jpeg";
    req.file.filename =
      path.basename(filePath, path.extname(filePath)) + ".jpg";
    req.file.path = filePath;

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
