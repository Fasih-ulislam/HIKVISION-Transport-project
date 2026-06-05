require("dotenv").config();

// middleware/basicAuth.js
module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return res.status(401).json({
      error: "Authorization required",
    });
  }

  try {
    const encoded = authHeader.split(" ")[1];

    const decoded = Buffer.from(encoded, "base64").toString("utf8");

    const [username, password] = decoded.split(":");

    if (
      username !== process.env.API_USERNAME ||
      password !== process.env.API_PASSWORD
    ) {
      return res.status(401).json({
        error: "Invalid credentials",
      });
    }

    next();
  } catch (err) {
    return res.status(401).json({
      error: "Invalid authorization header",
    });
  }
};
