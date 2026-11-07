
const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
  const authHeader = req.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Access token is required",
    });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  if (!token) {
    return res.status(401).json({
      error: "Access token is required",
    });
  }

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    return next(new Error("JWT_SECRET is not configured"));
  }

  try {
    const payload = jwt.verify(token, secret, {
      issuer: "reservoir-api",
      audience: "reservoir-client",
      algorithms: ["HS256"],
    });

    if (
      typeof payload === "string" ||
      typeof payload.sub !== "string" ||
      !["USER", "ADMIN"].includes(payload.role)
    ) {
      return res.status(401).json({
        error: "Invalid access token",
      });
    }

    req.user = {
      id: payload.sub,
      role: payload.role,
    };

    next();
  } catch (error) {
    if (
      error.name === "TokenExpiredError" ||
      error.name === "JsonWebTokenError" ||
      error.name === "NotBeforeError"
    ) {
      return res.status(401).json({
        error: "Invalid or expired access token",
      });
    }

    next(error);
  }
}

module.exports = authenticateToken;
