require("dotenv").config();
const express = require("express");
const debugRoutes = require("./routes/debugRoutes");
const userRoutes = require("./routes/userRoutes");
const loggingRoutes = require("./routes/loggingRoutes");

const app = express();

// ***enable only when going to backup image upload path***
app.use("/uploads", express.static("uploads"));

app.use(express.json({ limit: "10mb" }));

app.use("/debug", debugRoutes);
app.use("/students", userRoutes);
app.use("/logs", loggingRoutes);

// Start server
app.listen(process.env.PORT || 3000, () => {
  console.log(
    `Server running on ${process.env.SERVER_IP || "http://localhost"}:${process.env.PORT || 3000}`,
  );
});
