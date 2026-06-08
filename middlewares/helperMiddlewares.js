const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const { validateTime, getLocalISOTime } = require("../utils/helperFuntions");

module.exports.validateUpdate = (req, res, next) => {
  const file = req.file;

  const { employeeNo } = req.params;

  const { userType, beginTime, endTime, name } = req.body || {};

  // At least one field must be provided
  if (!userType && !beginTime && !endTime && !file && !name) {
    return res.status(400).json({
      error:
        "At least one field must be provided to update: name, userType, beginTime, endTime, faceImage",
    });
  }

  const allowedUserTypes = ["normal", "visitor", "blackList"];
  if (userType && !allowedUserTypes.includes(userType)) {
    return res
      .status(400)
      .json({ error: "Invalid user type", allowedUserTypes });
  }

  const hikTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

  if (beginTime) {
    const err = validateTime(beginTime, "beginTime");
    if (err) {
      return res.status(400).json({ error: err });
    }
  }

  if (endTime) {
    const err = validateTime(endTime, "endTime");
    if (err) {
      return res.status(400).json({ error: err });
    }
  }

  if (beginTime && endTime && new Date(endTime) <= new Date(beginTime)) {
    return res.status(400).json({ error: "endTime must be after beginTime" });
  }

  next();
};

module.exports.validateUser = (req, res, next) => {
  const { employeeNo, name, userType, beginTime, endTime } = req.body;
  const file = req.file;

  if (!employeeNo || !name || !file) {
    return res
      .status(400)
      .json({ error: "employeeNo, name and faceImage are required" });
  }

  const allowedMimeTypes = ["image/jpeg", "image/jpg"];
  const maxSizeBytes = 200 * 1024;

  if (!allowedMimeTypes.includes(file.mimetype) || file.size > maxSizeBytes) {
    return res
      .status(400)
      .json({ error: "Image must be a JPEG/JPG and less than 200 KB" });
  }

  const allowedUserTypes = ["normal", "visitor", "blackList"];
  if (userType && !allowedUserTypes.includes(userType)) {
    return res
      .status(400)
      .json({ error: "Invalid user type", allowedUserTypes });
  }

  const resolvedBeginTime = beginTime || getLocalISOTime();
  const resolvedEndTime = endTime || "2030-12-31T23:59:59";

  const beginError = validateTime(resolvedBeginTime, "beginTime");
  if (beginError) {
    return res.status(400).json({ error: beginError });
  }

  const endError = validateTime(resolvedEndTime, "endTime");
  if (endError) {
    return res.status(400).json({ error: endError });
  }

  if (new Date(resolvedEndTime) <= new Date(resolvedBeginTime)) {
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
    fs.unlink(filePath, () => {});
    console.error("Image compression failed:", err);
    return res
      .status(500)
      .json({ message: "Image compression failed", error: err.message });
  }
};

// Process BLOB images
module.exports.processBlobImage = async (req, res, next) => {
  if (!req.file) return next();

  try {
    const inputBuffer = req.file.buffer; // raw blob from multer memoryStorage

    // Validate it's actually an image
    const metadata = await sharp(inputBuffer).metadata();
    if (!metadata.format) {
      return res.status(400).json({ error: "Could not decode image data" });
    }

    console.log(
      `Input format: ${metadata.format}, dimensions: ${metadata.width}x${metadata.height}`,
    );

    // Convert to JPEG and compress in one step
    const filename = `${Date.now()}.jpg`;
    const filePath = `uploads/${filename}`;

    const targetSizeBytes = 200 * 1024;
    let outputBuffer;
    let usedWidth = metadata.width;
    let usedQuality = 85;

    const widthSteps = [1200, 1000, 800, 600, 400];

    outer: for (const width of widthSteps) {
      if (width >= metadata.width) continue;

      for (let quality = 85; quality >= 40; quality -= 10) {
        outputBuffer = await sharp(inputBuffer)
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer();

        if (outputBuffer.length <= targetSizeBytes) {
          usedWidth = width;
          usedQuality = quality;
          break outer;
        }
      }
    }

    // If already small enough or loop didn't trigger
    if (!outputBuffer || outputBuffer.length > targetSizeBytes) {
      outputBuffer = await sharp(inputBuffer)
        .rotate()
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg({ quality: 40 })
        .toBuffer();
    }

    fs.writeFileSync(filePath, outputBuffer);

    // Overwrite req.file to look exactly like before
    req.file = {
      filename,
      path: filePath,
      mimetype: "image/jpeg",
      size: outputBuffer.length,
      buffer: undefined, // clear raw buffer from memory
    };

    console.log(
      `[processBlobImage] ${metadata.format} blob → JPEG ${(outputBuffer.length / 1024).toFixed(1)}KB (${usedWidth}px @ quality ${usedQuality})`,
    );

    next();
  } catch (err) {
    return res
      .status(400)
      .json({ error: "Failed to process image", detail: err.message });
  }
};

module.exports.decodeBase64Image = async (req, res, next) => {
  const image = req.body.faceImage;
  if (!image) return next();

  const base64Regex = /^data:image\/(png|jpeg|jpg|webp|heic|bmp);base64,/i;
  if (!base64Regex.test(image)) {
    return res
      .status(400)
      .json({ error: "image must be a valid base64 encoded image string" });
  }

  try {
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const inputBuffer = Buffer.from(base64Data, "base64");

    const metadata = await sharp(inputBuffer).metadata();
    if (!metadata.format) {
      return res.status(400).json({ error: "Could not decode image" });
    }

    const targetSizeBytes = 200 * 1024;
    let outputBuffer;

    const widthSteps = [1200, 1000, 800, 600, 400];
    outer: for (const width of widthSteps) {
      if (width >= metadata.width) continue;
      for (let quality = 85; quality >= 40; quality -= 10) {
        outputBuffer = await sharp(inputBuffer)
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer();
        if (outputBuffer.length <= targetSizeBytes) break outer;
      }
    }

    if (!outputBuffer || outputBuffer.length > targetSizeBytes) {
      outputBuffer = await sharp(inputBuffer)
        .rotate()
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg({ quality: 40 })
        .toBuffer();
    }

    const filename = `${Date.now()}.jpg`;
    const filePath = `uploads/${filename}`;
    fs.writeFileSync(filePath, outputBuffer);

    req.file = {
      filename,
      path: filePath,
      mimetype: "image/jpeg",
      size: outputBuffer.length,
    };

    next();
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    return res
      .status(400)
      .json({ error: "Failed to process image", detail: err.message });
  }
};
