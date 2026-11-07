// Integration tests for the atomic reservation Lua scripts.
//
// Requires a running Redis (e.g. `docker compose up -d redis`).
// Uses database 15 and a unique key prefix so it never touches application data.
// Override with TEST_REDIS_URL. Tests are skipped if Redis is unreachable.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createClient } = require("redis");

const SCRIPTS = path.join(__dirname, "../src/scripts");
const reserveScript = fs.readFileSync(path.join(SCRIPTS, "reserveTicket.lua"), "utf8");
const confirmScript = fs.readFileSync(path.join(SCRIPTS, "confirmReservation.lua"), "utf8");
const expireScript = fs.readFileSync(path.join(SCRIPTS, "expireReservation.lua"), "utf8");

const url = process.env.TEST_REDIS_URL || "redis://localhost:6379/15";
const prefix = `test:${randomUUID()}:`;
const k = (name) => prefix + name;

const inventoryKey = k("inventory:evt");
const expirationKey = k("reservation:expirations");

let redis;
let available = false;
const createdReservationIds = [];

before(async () => {
  redis = createClient({ url, socket: { connectTimeout: 1000, reconnectStrategy: false } });
  redis.on("error", () => {});
  try {
    await redis.connect();
    await redis.ping();
    available = true;
  } catch {
    available = false;
  }
});

after(async () => {
  if (!available) return;
  // The Lua scripts build "reservation:<id>" keys (unprefixed) for idempotent replays,
  // so reservations are stored under that name too. Clean both kinds up.
  const keys = [
    ...(await redis.keys(`${prefix}*`)),
    ...createdReservationIds.map((id) => `reservation:${id}`),
  ];
  if (keys.length) await redis.del(keys);
  await redis.quit();
});

async function reserve({ quantity = 1, idemKey = randomUUID(), ttl = 60 } = {}) {
  const reservationId = randomUUID();
  createdReservationIds.push(reservationId);
  const result = await redis.eval(reserveScript, {
    keys: [inventoryKey, `reservation:${reservationId}`, k(`idempotency:user1:${idemKey}`), expirationKey],
    arguments: [reservationId, "evt", "user1", String(quantity), String(ttl)],
  });
  return { code: Number(result[0]), value: String(result[1]), reservationId };
}

async function nowSeconds() {
  const [seconds] = await redis.sendCommand(["TIME"]);
  return Number(seconds);
}

function skipIfNoRedis(t) {
  if (!available) {
    t.skip(`Redis not reachable at ${url}`);
    return true;
  }
  return false;
}

test("reserve decrements inventory and records the reservation", async (t) => {
  if (skipIfNoRedis(t)) return;
  await redis.set(inventoryKey, "10");

  const { code, value, reservationId } = await reserve({ quantity: 3 });

  assert.equal(code, 1);
  assert.equal(value, reservationId);
  assert.equal(await redis.get(inventoryKey), "7");
  const saved = JSON.parse(await redis.get(`reservation:${reservationId}`));
  assert.equal(saved.status, "RESERVED");
  assert.equal(saved.quantity, 3);
  assert.notEqual(await redis.zScore(expirationKey, reservationId), null);
});

test("reserve rejects requests larger than remaining inventory", async (t) => {
  if (skipIfNoRedis(t)) return;
  await redis.set(inventoryKey, "2");

  const { code, value } = await reserve({ quantity: 3 });

  assert.equal(code, -2);
  assert.equal(value, "INSUFFICIENT_INVENTORY");
  assert.equal(await redis.get(inventoryKey), "2");
});

test("reserve fails when inventory is not initialised", async (t) => {
  if (skipIfNoRedis(t)) return;
  await redis.del(inventoryKey);

  const { code, value } = await reserve();

  assert.equal(code, -1);
  assert.equal(value, "INVENTORY_NOT_INITIALIZED");
});

test("replaying an idempotency key returns the original reservation", async (t) => {
  if (skipIfNoRedis(t)) return;
  await redis.set(inventoryKey, "5");
  const idemKey = randomUUID();

  const first = await reserve({ quantity: 2, idemKey });
  const replay = await reserve({ quantity: 2, idemKey });

  assert.equal(first.code, 1);
  assert.equal(replay.code, 2);
  assert.equal(replay.value, first.reservationId);
  assert.equal(await redis.get(inventoryKey), "3", "seats are only taken once");
});

test("concurrent reservations never oversell", async (t) => {
  if (skipIfNoRedis(t)) return;
  await redis.set(inventoryKey, "5");

  const results = await Promise.all(Array.from({ length: 20 }, () => reserve({ quantity: 1 })));

  assert.equal(results.filter((r) => r.code === 1).length, 5);
  assert.equal(results.filter((r) => r.code === -2).length, 15);
  assert.equal(await redis.get(inventoryKey), "0");
});

test("confirm marks a live reservation CONFIRMED and is idempotent", async (t) => {
  if (skipIfNoRedis(t)) return;
  await redis.set(inventoryKey, "5");
  const { reservationId } = await reserve();
  const reservationKey = `reservation:${reservationId}`;
  const now = String(await nowSeconds());

  const first = await redis.eval(confirmScript, { keys: [reservationKey, expirationKey], arguments: [now] });
  const second = await redis.eval(confirmScript, { keys: [reservationKey, expirationKey], arguments: [now] });

  assert.deepEqual(first.map(String), ["1", "CONFIRMED"]);
  assert.deepEqual(second.map(String), ["1", "ALREADY_CONFIRMED"]);
  assert.equal(JSON.parse(await redis.get(reservationKey)).status, "CONFIRMED");
  assert.equal(await redis.zScore(expirationKey, reservationId), null);
});

test("confirm rejects an expired reservation", async (t) => {
  if (skipIfNoRedis(t)) return;
  await redis.set(inventoryKey, "5");
  const { reservationId } = await reserve();
  const reservationKey = `reservation:${reservationId}`;
  const reservation = JSON.parse(await redis.get(reservationKey));

  const result = await redis.eval(confirmScript, {
    keys: [reservationKey, expirationKey],
    arguments: [String(reservation.expiresAt)],
  });

  assert.deepEqual(result.map(String), ["0", "RESERVATION_EXPIRED"]);
});

test("expire restores seats exactly once and never touches confirmed reservations", async (t) => {
  if (skipIfNoRedis(t)) return;
  await redis.set(inventoryKey, "10");
  const { reservationId } = await reserve({ quantity: 4 });
  const reservationKey = `reservation:${reservationId}`;
  const expireArgs = { keys: [reservationKey, inventoryKey, expirationKey], arguments: [reservationId] };

  // Not due yet.
  assert.deepEqual((await redis.eval(expireScript, expireArgs)).map(String), ["0", "RESERVATION_NOT_EXPIRED"]);
  assert.equal(await redis.get(inventoryKey), "6");

  // Move the hold into the past.
  const reservation = JSON.parse(await redis.get(reservationKey));
  reservation.expiresAt = (await nowSeconds()) - 10;
  await redis.set(reservationKey, JSON.stringify(reservation));

  assert.deepEqual((await redis.eval(expireScript, expireArgs)).map(String), ["1", "EXPIRED"]);
  assert.equal(await redis.get(inventoryKey), "10");

  // A second run (e.g. another worker) must not restore seats again.
  assert.deepEqual((await redis.eval(expireScript, expireArgs)).map(String), ["0", "RESERVATION_NOT_ACTIVE"]);
  assert.equal(await redis.get(inventoryKey), "10");
});
