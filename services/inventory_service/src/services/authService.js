
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const redis = require("../config/redis");

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_SECONDS = Number(
  process.env.REFRESH_TOKEN_TTL_SECONDS || 7 * 24 * 60 * 60
);

// Only a SHA-256 hash of each refresh token is stored, so a Redis dump
// cannot be replayed as live sessions.
function refreshKey(refreshToken) {
  const hash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  return `refresh:${hash}`;
}

function signAccessToken(user) {
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error("JWT_SECRET is not configured");
  }

  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
    },
    jwtSecret,
    {
      expiresIn: ACCESS_TOKEN_TTL,
      issuer: "ticket-booking-api",
      audience: "ticket-booking-client",
    }
  );
}

// Issue a short-lived access token plus a single-use refresh token.
async function issueSession(user) {
  const token = signAccessToken(user);
  const refreshToken = crypto.randomBytes(48).toString("base64url");

  await redis.set(
    refreshKey(refreshToken),
    JSON.stringify({ userId: user.id, issuedAt: Date.now() }),
    { EX: REFRESH_TOKEN_TTL_SECONDS }
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    token,
    refreshToken,
    refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
  };
}

function invalidRefreshError() {
  const error = new Error("Invalid or expired refresh token");
  error.code = "INVALID_REFRESH_TOKEN";
  return error;
}

// Register a new user
async function registerUser({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existingUser) {
    const error = new Error("Email is already registered");
    error.code = "EMAIL_ALREADY_EXISTS";
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash,
    },
    select: {
      id: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });

  return user;
}

// Log in an existing user
async function loginUser({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // Use the same error for an unknown email and an incorrect password.
  if (!user) {
    const error = new Error("Invalid email or password");
    error.code = "INVALID_CREDENTIALS";
    throw error;
  }

  const passwordMatches = await bcrypt.compare(
    password,
    user.passwordHash
  );

  if (!passwordMatches) {
    const error = new Error("Invalid email or password");
    error.code = "INVALID_CREDENTIALS";
    throw error;
  }

  return issueSession(user);
}

// Exchange a refresh token for a new session (rotation).
// GETDEL makes the old token single-use even under concurrent requests.
async function refreshSession(refreshToken) {
  const raw = await redis.getDel(refreshKey(refreshToken));

  if (!raw) {
    throw invalidRefreshError();
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw invalidRefreshError();
  }

  // Re-read the user so role changes and deletions take effect on refresh.
  const user = await prisma.user.findUnique({
    where: { id: record.userId },
    select: { id: true, email: true, role: true },
  });

  if (!user) {
    throw invalidRefreshError();
  }

  return issueSession(user);
}

async function revokeRefreshToken(refreshToken) {
  await redis.del(refreshKey(refreshToken));
}

module.exports = {
  registerUser,
  loginUser,
  refreshSession,
  revokeRefreshToken,
};
