
const express = require("express");
const authController = require("../controllers/authController");
const authenticateToken = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/register", authController.register);
router.post("/login", authController.login);

// The refresh token itself is the credential, so no access token is needed.
router.post("/refresh", authController.refresh);
router.post("/logout", authController.logout);

router.get(
  "/me",
  authenticateToken,
  authController.getCurrentUser
);

module.exports = router;
