const express = require("express");
const router = express.Router();
const debugController = require("../controllers/debugController");

// debugging routes
router.get("/health-check", debugController.healthCheck);

router.get("/fdlib", debugController.fdlib);

router.get("/capabilities", debugController.capabilities);

router.get("/faces/:employeeNo", debugController.faces);

router.get("/fdsetup", debugController.fdsetup);

module.exports = router;
