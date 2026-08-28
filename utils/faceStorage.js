// Durable face-image storage. Files are versioned so retries never read an
// image that a later update has overwritten.
const fs = require("fs/promises");
const path = require("path");

const FACE_STORAGE_ROOT = path.join("storage", "faces");

async function persistFaceImage(file, userId, imageVersion) {
  if (!file?.path) throw new Error("Cannot persist face image: uploaded file is missing");
  const relativePath = path.join(FACE_STORAGE_ROOT, String(userId), `v${imageVersion}.jpg`);
  const absolutePath = path.resolve(process.cwd(), relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.copyFile(file.path, absolutePath);
  return relativePath;
}

function resolveFaceImagePath(relativePath) {
  if (!relativePath) return null;
  const root = path.resolve(process.cwd(), FACE_STORAGE_ROOT);
  const absolutePath = path.resolve(process.cwd(), relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
    throw new Error("Stored face image path is outside the face storage root");
  }
  return absolutePath;
}

async function removeFaceImage(relativePath) {
  const absolutePath = resolveFaceImagePath(relativePath);
  if (!absolutePath) return;
  try { await fs.unlink(absolutePath); } catch (err) { if (err.code !== "ENOENT") throw err; }
}

module.exports = { persistFaceImage, resolveFaceImagePath, removeFaceImage };
