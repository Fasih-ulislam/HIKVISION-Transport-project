const mongoose = require("mongoose");

// UIS's modified-user endpoint has no date/cursor argument. This isolated
// state table makes repeated results idempotent without changing User or the
// device-sync data model.
const uisImportStateSchema = new mongoose.Schema(
  {
    formNo: { type: String, required: true, unique: true },
    fingerprint: { type: String, required: true },
    lastImportedAt: { type: Date, required: true, default: Date.now },
    registeredMarkedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("UisImportState", uisImportStateSchema);
