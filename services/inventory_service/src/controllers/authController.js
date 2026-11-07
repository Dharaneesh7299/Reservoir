
const authService = require("../services/authService");

// Register a new user
async function register(req, res, next) {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ) {
      return res.status(400).json({
        error: "A valid email address is required",
      });
    }

    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 72
    ) {
      return res.status(400).json({
        error: "Password must be between 8 and 72 characters",
      });
    }

    const user = await authService.registerUser({
      email,
      password,
    });

    return res.status(201).json({
      message: "User registered successfully",
      user,
    });
  } catch (error) {
    if (
      error.code === "EMAIL_ALREADY_EXISTS" ||
      error.code === "P2002"
    ) {
      return res.status(409).json({
        error: "Email is already registered",
      });
    }

    return next(error);
  }
}

// Log in an existing user
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ) {
      return res.status(400).json({
        error: "A valid email address is required",
      });
    }

    if (
      typeof password !== "string" ||
      password.length === 0
    ) {
      return res.status(400).json({
        error: "Password is required",
      });
    }

    const result = await authService.loginUser({
      email,
      password,
    });

    return res.status(200).json({
      message: "Login successful",
      ...result,
    });
  } catch (error) {
    if (error.code === "INVALID_CREDENTIALS") {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    return next(error);
  }
}

function validRefreshToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

// Exchange a refresh token for a new access token + refresh token.
async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body || {};

    if (!validRefreshToken(refreshToken)) {
      return res.status(400).json({
        error: "A valid refreshToken is required",
      });
    }

    const result = await authService.refreshSession(refreshToken);

    return res.status(200).json({
      message: "Session refreshed",
      ...result,
    });
  } catch (error) {
    if (error.code === "INVALID_REFRESH_TOKEN") {
      return res.status(401).json({
        error: "Invalid or expired refresh token",
      });
    }

    return next(error);
  }
}

// Revoke a refresh token. Always 204, so callers can't probe token validity.
async function logout(req, res, next) {
  try {
    const { refreshToken } = req.body || {};

    if (validRefreshToken(refreshToken)) {
      await authService.revokeRefreshToken(refreshToken);
    }

    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

async function getCurrentUser(req, res, next) {
  try {
    const prisma = require("../config/prisma");
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        role: true,
      },
    });

    return res.status(200).json({
      user: user || req.user,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  getCurrentUser,
};
