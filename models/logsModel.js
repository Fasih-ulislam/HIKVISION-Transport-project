// models/Log.js

const mongoose = require("mongoose");

const logSchema = new mongoose.Schema(
  {
    method: String,
    url: String,
    statusCode: Number,

    requestBody: mongoose.Schema.Types.Mixed,
    responseBody: mongoose.Schema.Types.Mixed,

    params: mongoose.Schema.Types.Mixed,
    query: mongoose.Schema.Types.Mixed,

    durationMs: Number,

    ip: String,

    error: mongoose.Schema.Types.Mixed,
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Log", logSchema);
