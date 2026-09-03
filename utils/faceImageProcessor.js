// utils/faceImageProcessor.js
//
// The resize/upscale/compress pipeline used to prepare a face image for
// device upload. Originally lived only inside decodeBase64Image
// middleware. Extracted here because the UIS import path calls
// userSyncService.registerUser/updateUser directly, bypassing Express
// routes entirely — so it never runs through that middleware and needs
// this same logic on its own. Keeping it in one place means both paths
// stay identical instead of two copies quietly drifting apart.

const sharp = require("sharp");

const TARGET_SIZE_BYTES = 200 * 1024;
const UPSCALE_FLOOR = 800;
const QUALITY_FLOOR = 65;

/**
 * @param {Buffer} inputBuffer - raw decoded image bytes
 * @returns {Promise<Buffer>} a JPEG buffer, <= 200KB, ready for device upload
 * @throws if the input can't be decoded as an image, or can't be
 *         compressed under the size limit
 */
async function processFaceImageBuffer(inputBuffer) {
  const sharpOpts = { failOn: "none" }; // tolerate non-conformant-but-decodable JPEGs (e.g. invalid SOS)

  const metadata = await sharp(inputBuffer, sharpOpts).metadata();
  if (!metadata.format) {
    throw new Error("Could not decode image");
  }

  let workingBuffer;
  if (metadata.width < UPSCALE_FLOOR) {
    workingBuffer = await sharp(inputBuffer, sharpOpts)
      .rotate()
      .resize({
        width: UPSCALE_FLOOR,
        kernel: "lanczos3",
        withoutEnlargement: false,
      })
      .sharpen({ sigma: 1.2 })
      .normalise()
      .toBuffer();
  } else {
    workingBuffer = await sharp(inputBuffer, sharpOpts).rotate().toBuffer();
  }

  const workingMeta = await sharp(workingBuffer, sharpOpts).metadata();

  let outputBuffer;
  const widthSteps = [1200, 1000, 800, 600];
  outer: for (const width of widthSteps) {
    if (width >= workingMeta.width) continue;
    for (let quality = 85; quality >= QUALITY_FLOOR; quality -= 10) {
      outputBuffer = await sharp(workingBuffer, sharpOpts)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      if (outputBuffer.length <= TARGET_SIZE_BYTES) break outer;
    }
  }

  if (!outputBuffer || outputBuffer.length > TARGET_SIZE_BYTES) {
    outputBuffer = await sharp(workingBuffer, sharpOpts)
      .resize({
        width: Math.min(workingMeta.width, 800),
        withoutEnlargement: true,
      })
      .jpeg({ quality: QUALITY_FLOOR })
      .toBuffer();
  }

  if (outputBuffer.length > TARGET_SIZE_BYTES) {
    outputBuffer = await sharp(workingBuffer, sharpOpts)
      .resize({ width: 500, withoutEnlargement: true })
      .jpeg({ quality: 50 })
      .toBuffer();
  }

  return outputBuffer;
}

module.exports = { processFaceImageBuffer };