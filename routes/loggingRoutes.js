const express = require("express");
const router = express.Router();
const { hikRequest } = require("../utils/helperFuntions");

router.get("/", async (req, res) => {
  const start = req.query.start || "2026-05-1";
  const end = req.query.end || "2026-12-31";

  const result = await hikRequest(
    "POST",
    "/ISAPI/AccessControl/AcsEvent",

    // {
    //   AcsEventCond: {
    //     searchID: "1",
    //     searchResultPosition: 0,
    //     maxResults: 30,
    //     major: 5,
    //     minor: 75,
    //   },
    // },

    {
      AcsEventCond: {
        searchID: "session_99",
        searchResultPosition: 0,
        maxResults: 10,
        major: 5,
        minor: 0,
        timeReverseOrder: true,
        doorNo: 1,
      },
    },
  );

  if (!result.success) {
    return res
      .status(500)
      .json({ error: "Failed to fetch logs", detail: result.error });
  }

  return res.json({ success: true, data: result.data });
});

module.exports = router;
