const mongoose = require("mongoose");
const { startAlertStreams } = require("../services/alertStreamService");

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);

    console.log(
      `MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`,
    );
    startAlertStreams();
  } catch (error) {
    console.error("MongoDB Connection Error:", error.message);

    process.exit(1);
  }
};

module.exports = connectDB;
