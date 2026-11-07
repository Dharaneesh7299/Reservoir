# Changelog

A code review of Reservoir found the gaps below, and each one was fixed as its own phase. For the current design, see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Phases 1–10** fix problems without changing the architecture.
- **Phases 11–13** extend it: a Redis key for the event index, Order Service retry and DLQ queues, and refresh-token endpoints. They add to the existing services and stores and replace nothing, and ARCHITECTURE.md already describes them.

## Fixes

| Phase | Issue | Status | Fix |
|---|---|---|---|
| 1 | The expiration worker wasn't in `docker-compose.yml`, so in Compose, unconfirmed reservations never expired and their seats never came back | ✅ Fixed | Added an `expiration-worker` Compose service. It reuses the `reservoir-inventory` image and runs `npm run worker:expiration` |
| 2 | Sign Out threw an error: `handleLogout` in [App.jsx](ticket-booking-frontend/src/App.jsx) called `setBookings`, which was never defined | ✅ Fixed | Removed the call. `bookings` is derived from the current user, so it clears itself on logout |
| 3 | The CI workflow built `./ticket-booking-system`, which doesn't exist | ✅ Fixed | A matrix job builds and pushes `reservoir-frontend`, `reservoir-inventory`, `reservoir-order` and `reservoir-notification`, and runs only after the `test` job passes |
| 4 | No `.env.example` for `order_service` or `notification_service`, although Compose requires their `.env` files | ✅ Fixed | Added both, and documented host-port URLs in the inventory example |
| 5 | The email sender was hard-coded to `onboarding@resend.dev`, which only delivers to the Resend account owner | ✅ Fixed | New `EMAIL_FROM` variable. The old address remains the default |
| 6 | Migrations needed a hard-to-remember `--config prisma7.config.ts` flag | ✅ Fixed | Added `npm run migrate:deploy`, `migrate:dev` and `prisma:generate` (inventory) and `start`, `dev` and `prisma:generate` (order) |
| 7 | Postgres and RabbitMQ credentials were hard-coded in `docker-compose.yml` | ✅ Fixed | They are read from a root `.env` (see `.env.example`), with the old values as defaults |
| 8 | "Confirm in Demo Mode" saved bookings the backend never knew about | ✅ Fixed | Removed the button, its handler and its CSS. Leftover `demo-*` entries are dropped from the cache on the next refresh |
| 9 | `src/data/events.jsx` was a static catalogue that nothing imported | ✅ Fixed | Deleted, along with the empty `src/data/` folder, with the owner's approval |
| 10 | No tests | ✅ Fixed | [tests/reservation.test.js](services/inventory_service/tests/reservation.test.js) covers the three Lua scripts against real Redis (DB 15, isolated key prefix) using `node --test`, including a 20-way concurrency test. Runs in CI |

## Architecture extensions

| Phase | Issue | Status | Fix | Sections affected |
|---|---|---|---|---|
| 11 | `GET /api/events` used `KEYS inventory:*`, which is O(N) and blocks Redis | ✅ Fixed | New `events:index` set, kept in step with admin create/delete in a single `MULTI`. Listing uses `SMEMBERS` and two `MGET`s. On startup the index is filled from existing data with a non-blocking, idempotent `SCAN` | ARCHITECTURE.md §3.3, §10 |
| 12 | The Order consumer had no DLQ, so a message that always failed was requeued forever | ✅ Fixed | `order.retry` (5 s delay) and `order.dlq`, following the Notification Service's pattern: up to 5 attempts, invalid JSON sent straight to the DLQ, and acks only after a confirmed hand-off | ARCHITECTURE.md §5 |
| 13 | No refresh tokens: users were logged out after 15 minutes | ✅ Fixed | Rotating, single-use refresh tokens (`POST /api/auth/refresh`, `POST /api/auth/logout`) stored as hashes in Redis. The frontend refreshes before expiry and keeps tabs in sync | ARCHITECTURE.md §3.2, §3.3, §7, §8 |

## Known limitations

- Refresh tokens are kept in `localStorage`. Moving them to an `httpOnly` cookie would protect them from XSS, but needs cookie and CSRF handling on the API.
- Tests cover only the Lua scripts. The event index, refresh rotation and the Order retry path need Postgres and RabbitMQ fixtures to test.
