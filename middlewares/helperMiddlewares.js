const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const { validateTime } = require("../utils/helperFuntions");

module.exports.validateUser = (req, res, next) => {
  const { employeeNo, name, userType, beginTime, endTime } = req.body;
  const file = req.file;

  if (!employeeNo || !name || !file) {
    if (file) fs.unlink(file.path, () => {});
    return res
      .status(400)
      .json({ error: "employeeNo, name and faceImage are required" });
  }

  const allowedMimeTypes = ["image/jpeg", "image/jpg"];
  const maxSizeBytes = 200 * 1024;

  if (!allowedMimeTypes.includes(file.mimetype) || file.size > maxSizeBytes) {
    if (file.path) fs.unlink(file.path, () => {});
    return res
      .status(400)
      .json({ error: "Image must be a JPEG/JPG and less than 200 KB" });
  }

  const allowedUserTypes = ["normal", "visitor", "blackList"];
  if (userType && !allowedUserTypes.includes(userType)) {
    fs.unlink(file.path, () => {});
    return res
      .status(400)
      .json({ error: "Invalid user type", allowedUserTypes });
  }

  const resolvedBeginTime = beginTime || "2026-01-01T00:00:00";
  const resolvedEndTime = endTime || "2030-12-31T23:59:59";

  const beginError = validateTime(resolvedBeginTime, "beginTime");
  if (beginError) {
    fs.unlink(file.path, () => {});
    return res.status(400).json({ error: beginError });
  }

  const endError = validateTime(resolvedEndTime, "endTime");
  if (endError) {
    fs.unlink(file.path, () => {});
    return res.status(400).json({ error: endError });
  }

  if (new Date(resolvedEndTime) <= new Date(resolvedBeginTime)) {
    fs.unlink(file.path, () => {});
    return res.status(400).json({ error: "endTime must be after beginTime" });
  }
  req.body.beginTime = resolvedBeginTime;
  req.body.endTime = resolvedEndTime;

  next();
};

// ─── Image compression middleware ────────────────────────────────────────────
module.exports.compressImage = async (req, res, next) => {
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
    fs.unlink(file.path, () => {});
    console.error("Image compression failed:", err);
    return res
      .status(500)
      .json({ message: "Image compression failed", error: err.message });
  }
};
