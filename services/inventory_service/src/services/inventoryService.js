const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const redis = require("../config/redis");

const scriptPath = path.join(__dirname, "../scripts/reserveTicket.lua");
const reserveScript = fs.readFileSync(scriptPath, "utf8");

const confirmScriptPath = path.join(
  __dirname,
  "../scripts/confirmReservation.lua"
);

const confirmScript = fs.readFileSync(
  confirmScriptPath,
  "utf8"
);

// Set of all event IDs. Lets GET /api/events list events without `KEYS`,
// which is O(N) over the whole keyspace and blocks Redis while it runs.
const EVENT_INDEX_KEY = "events:index";

async function setInventory(eventId, quantity, metadata = null) {
  const key = `inventory:${eventId}`;

  const multi = redis.multi().set(key, String(quantity)).sAdd(EVENT_INDEX_KEY, eventId);

  if (metadata && typeof metadata === "object") {
    multi.set(`event:meta:${eventId}`, JSON.stringify(metadata));
  }

  await multi.exec();

  return { eventId, available: quantity, metadata };
}

async function deleteInventory(eventId) {
  await redis
    .multi()
    .del(`inventory:${eventId}`)
    .del(`event:meta:${eventId}`)
    .sRem(EVENT_INDEX_KEY, eventId)
    .exec();
  return { eventId, deleted: true };
}

// One-time backfill for data created before the index existed.
// SCAN iterates incrementally, so unlike KEYS it never blocks Redis.
async function backfillEventIndex() {
  let added = 0;
  for await (const batch of redis.scanIterator({ MATCH: "inventory:*", COUNT: 200 })) {
    // node-redis v5+ yields arrays of keys; older versions yield single keys.
    const keys = Array.isArray(batch) ? batch : [batch];
    const eventIds = keys.map((key) => key.slice("inventory:".length));
    if (eventIds.length) {
      added += await redis.sAdd(EVENT_INDEX_KEY, eventIds);
    }
  }
  return added;
}

async function getAllInventory() {
  const eventIds = await redis.sMembers(EVENT_INDEX_KEY);
  if (!eventIds || eventIds.length === 0) {
    return [];
  }

  // Two round trips in total, regardless of how many events exist.
  const [availableValues, metaValues] = await Promise.all([
    redis.mGet(eventIds.map((id) => `inventory:${id}`)),
    redis.mGet(eventIds.map((id) => `event:meta:${id}`)),
  ]);

  const items = [];
  eventIds.forEach((eventId, i) => {
    const available = availableValues[i];
    if (available !== null && Number(available) > 0) {
      const metaStr = metaValues[i];
      let metadata = null;
      if (metaStr) {
        try {
          metadata = JSON.parse(metaStr);
        } catch {
          // ignore parsing error
        }
      }

      items.push({
        id: eventId,
        eventId,
        available: Number(available),
        name: metadata?.name || eventId,
        category: metadata?.category || "Live Event",
        icon: metadata?.icon || "🎟️",
        date: metadata?.date || "Upcoming",
        location: metadata?.location || "Venue TBA",
        price: typeof metadata?.price === "number" ? metadata.price : 0,
        type: metadata?.type || "Standard Admission",
      });
    }
  });

  items.sort((a, b) => a.eventId.localeCompare(b.eventId));
  return items;
}

async function getInventory(eventId) {
  const key = `inventory:${eventId}`;
  const available = await redis.get(key);

  if (available === null) {
    return null;
  }

  return {
    eventId,
    available: Number(available),
  };
}

async function reserveTickets({
  eventId,
  userId,
  quantity,
  idempotencyKey,
}) {
  const reservationId = randomUUID();

  const inventoryKey = `inventory:${eventId}`;
  const reservationKey = `reservation:${reservationId}`;
  const idempotencyRedisKey =
    `idempotency:${userId}:${idempotencyKey}`;

  const ttl = Number(process.env.RESERVATION_TTL_SECONDS || 1800);

  const result = await redis.eval(reserveScript, {
    keys: [
    inventoryKey,
    reservationKey,
    idempotencyRedisKey,
    "reservation:expirations",
    ],
    arguments: [
      reservationId,
      String(eventId),
      String(userId),
      String(quantity),
      String(ttl),
    ],
  });

  const code = Number(result[0]);
  const returnedId = String(result[1]);

  if (code === 1 || code === 2) {
    const savedReservation = await redis.get(
      `reservation:${returnedId}`
    );

    if (!savedReservation) {
      throw new Error("RESERVATION_RECORD_NOT_FOUND");
    }

    return {
      created: code === 1,
      reservation: JSON.parse(savedReservation),
    };
  }

  if (code === -1) {
    const error = new Error("Inventory has not been initialized");
    error.code = "INVENTORY_NOT_INITIALIZED";
    throw error;
  }

  if (code === -2) {
    const error = new Error("Insufficient tickets available");
    error.code = "INSUFFICIENT_INVENTORY";
    throw error;
  }

  const error = new Error(String(result[1]));
  error.code = "INVALID_RESERVATION_REQUEST";
  throw error;
}

async function getReservation(reservationId) {
  const value = await redis.get(`reservation:${reservationId}`);

  return value ? JSON.parse(value) : null;
}

async function confirmReservation(reservationId) {
  const reservationKey = `reservation:${reservationId}`;

  const result = await redis.eval(confirmScript, {
    keys: [
      reservationKey,
      "reservation:expirations",
    ],
    arguments: [
      String(Math.floor(Date.now() / 1000)),
    ],
  });

  const code = Number(result[0]);
  const message = String(result[1]);

  if (code === 1) {
    return {
      confirmed: true,
      message,
    };
  }

  if (message === "RESERVATION_NOT_FOUND") {
    const error = new Error("Reservation not found");
    error.code = message;
    throw error;
  }

  if (message === "RESERVATION_EXPIRED") {
    const error = new Error("Reservation has expired");
    error.code = message;
    throw error;
  }

  const error = new Error("Reservation is not active");
  error.code = message;
  throw error;
}

module.exports = {
  EVENT_INDEX_KEY,
  backfillEventIndex,
  setInventory,
  deleteInventory,
  getInventory,
  getAllInventory,
  reserveTickets,
  getReservation,
  confirmReservation,
};