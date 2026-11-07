# TicketHub: Event-Driven Ticket Booking Platform

TicketHub is a ticket booking system built from small, independent services. Users browse live events, reserve seats, and confirm their booking. Admins manage events and seat counts. Behind the scenes, the system guarantees that **a seat is never sold twice**, that **retried requests never double-book**, and that **slow work such as sending emails never delays a booking**.

It is built with **Node.js / Express 5**, **React 19**, **Redis** (atomic Lua scripts), **PostgreSQL** (Prisma 7) and **RabbitMQ**, and runs with one `docker compose` command.

> 📐 This README explains every component and workflow. For low-level design details (key schemas, error codes, scaling notes, the remediation log), see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Why it's built this way (benefits)](#2-why-its-built-this-way-benefits)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Components](#4-components)
5. [Where data lives](#5-where-data-lives)
6. [Events and messaging](#6-events-and-messaging)
7. [Workflows, step by step](#7-workflows-step-by-step)
8. [Reliability guarantees](#8-reliability-guarantees)
9. [Tech stack](#9-tech-stack)
10. [Project structure](#10-project-structure)
11. [Getting started (Docker)](#11-getting-started-docker)
12. [How to use](#12-how-to-use)
13. [Local development](#13-local-development)
14. [Configuration](#14-configuration)
15. [API reference](#15-api-reference)
16. [Testing](#16-testing)
17. [Operations and monitoring](#17-operations-and-monitoring)
18. [Troubleshooting](#18-troubleshooting)
19. [Project history and known limitations](#19-project-history-and-known-limitations)

---

## 1. What it does

| For | Capability |
|---|---|
| **Visitors** | Browse and search live events with real-time seat availability |
| **Users** | Register and sign in. Reserve 1–10 seats, confirm the booking, see all bookings and their status, and get emails when a booking is confirmed or expires |
| **Admins** | Create, update and delete events (name, category, date, venue, price, seat count) from the UI or the API |
| **The system** | Holds reserved seats for a limited time (30 min by default) and returns them automatically if the booking is never confirmed |

## 2. Why it's built this way (benefits)

| Benefit | How it's achieved |
|---|---|
| **No overselling, even in a flash-sale rush** | Each seat check-and-decrement runs as one atomic Redis Lua script. Two buyers can never both get the last seat. |
| **Safe retries and double clicks** | Every reservation carries an `Idempotency-Key`. Repeating a request returns the original reservation instead of taking more seats. |
| **Fast bookings** | Seat counts live in memory (Redis). Emails and order bookkeeping happen afterwards, through a message queue. |
| **Failures don't break bookings** | If the email provider or Order Service is down, bookings still succeed. Events wait in durable queues until the service recovers. |
| **No lost messages** | Publisher confirms, durable queues, persistent messages, and acknowledgements only after work succeeds. |
| **No stuck messages** | Failing messages are retried after a delay, then parked in a dead-letter queue for inspection. |
| **Seats are never lost** | Abandoned reservations expire automatically, and their seats are returned exactly once. |
| **Long sessions without long-lived tokens** | Access tokens last 15 minutes. Rotating, single-use refresh tokens keep users signed in for up to 7 days. |
| **Scales out** | The API and consumer services hold no state of their own and can be run as several copies. |

---

## 3. Architecture at a glance

```mermaid
flowchart LR
    Browser["🌐 Browser<br/>React SPA"]

    subgraph Edge["Presentation"]
        Nginx["Nginx :3000<br/>static files + /api proxy"]
    end

    subgraph API["Synchronous API"]
        Inv["Inventory Service :4001<br/>auth · events · reservations · orders"]
    end

    subgraph Async["Asynchronous processing"]
        Worker["Expiration Worker<br/>every 1 s"]
        Order["Order Service<br/>event consumer"]
        Notif["Notification Service<br/>event consumer"]
    end

    subgraph Data["Data & messaging"]
        Redis[("Redis<br/>seats · reservations<br/>sessions · event index")]
        PG[("PostgreSQL<br/>users · orders")]
        MQ{{"RabbitMQ<br/>ticket.events"}}
    end

    Resend["📧 Resend<br/>email API"]

    Browser --> Nginx --> Inv
    Inv -->|Lua scripts| Redis
    Inv -->|Prisma| PG
    Inv -->|publish events| MQ
    Worker --> Redis
    Worker --> PG
    Worker -->|reservation.expired| MQ
    MQ --> Order --> PG
    MQ --> Notif --> Resend
```

The system has four layers:

1. **Presentation:** a React single-page app, served by Nginx. Nginx also forwards every `/api/*` call to the backend, so the browser only ever talks to one address.
2. **Synchronous API:** the **Inventory Service** is the only service the browser talks to. It handles anything that needs an immediate answer: signing in, listing events, reserving and confirming seats, listing orders.
3. **Asynchronous processing:** work that can happen a moment later. The **Expiration Worker** returns seats from abandoned holds. The **Order Service** keeps the order history up to date. The **Notification Service** sends emails. These services never block a user's request.
4. **Data and messaging:**
   - **Redis** holds the fast-changing state: seat counts, reservations, sessions.
   - **PostgreSQL** holds the durable records: users and orders.
   - **RabbitMQ** carries events between services.

The services never call each other directly. They communicate only through **events on RabbitMQ**, so each one can be deployed, scaled, restarted or fail on its own.

---

## 4. Components

### 4.1 Frontend: React SPA (`ticket-booking-frontend/`)

| | |
|---|---|
| **What** | The web app users see: event catalogue, booking pop-up, "My Bookings", sign-in pop-up, admin event editor |
| **Tech** | React 19, React Router 7, Vite 8, plain CSS with design tokens (light theme, motion that respects reduced-motion settings) |
| **Talks to** | Inventory Service only, through relative `/api/...` URLs |
| **Key files** | `src/App.jsx` (routing, booking flow), `src/pages/Events.jsx`, `src/pages/Bookings.jsx`, `src/components/*` (EventCard, AuthModal, AdminAddTicketsModal), `src/context/AuthProvider.jsx` (session handling), `src/services/api.js` (all HTTP calls) |

How it works:
- **Session handling:** `AuthProvider` stores the access token, refresh token and user in `localStorage`. It renews the session about a minute before the access token expires and keeps open tabs in sync.
- **Booking:** a single click on **Confirm & Pay** sends two requests: *reserve*, then *confirm*. Each reserve request gets a fresh idempotency key.
- **"My Bookings":** shows server orders merged with a small per-user cache, so a confirmed booking appears instantly.

### 4.2 Nginx (inside the frontend container)

| | |
|---|---|
| **What** | Web server and reverse proxy |
| **Does** | Serves the built app with gzip and long-lived caching for hashed assets. Falls back to `index.html` so client-side routes work. Proxies `/api/*` and `/health` to `inventory:4001`. Exposes `/nginx-health` for Docker health checks |
| **Why** | The browser stays on one origin (`localhost:3000`), so there's no CORS setup and no Docker hostnames in browser code |
| **Key file** | `ticket-booking-frontend/nginx.conf` |

### 4.3 Inventory Service (`services/inventory_service/`): the core API

| | |
|---|---|
| **What** | The only public API, an Express 5 app on port `4001` |
| **Owns** | User accounts and sessions, event inventory, the reservation lifecycle, order listing |
| **Talks to** | Redis (seats, reservations, sessions), PostgreSQL (users, orders), RabbitMQ (publishes `reservation.*` events) |
| **Layers** | `routes/` → `middleware/` (JWT check, role check) → `controllers/` (validation, HTTP status codes) → `services/` (business logic) → `config/` (Redis, Prisma, RabbitMQ clients) |
| **Atomic scripts** | `src/scripts/reserveTicket.lua`, `confirmReservation.lua`, `expireReservation.lua` |

Responsibilities in detail:
- **Auth:**
  - Registration hashes the password with bcrypt (cost 12).
  - Login issues a 15-minute JWT and a 7-day refresh token.
  - Refresh swaps a refresh token for a new pair, and each refresh token works only once.
  - Logout revokes the refresh token.
- **Inventory:** admins set seat counts and event details. Every event ID is also recorded in an `events:index` set, so listing never has to scan all of Redis.
- **Reservations:**
  - *Reserve* atomically takes seats and creates a hold with an expiry time.
  - *Confirm* atomically turns the hold into a confirmed booking.
  - Each step also writes the order to Postgres and publishes an event.
- **Orders:** returns the user's orders, adds event details, and corrects any status that has fallen behind Redis.
- **Startup:** connects to Redis, fills the event index for older data, sets up RabbitMQ, and only then starts accepting traffic. On `SIGTERM` it finishes in-flight requests and closes its connections cleanly.

### 4.4 Expiration Worker (`services/inventory_service/src/workers/`)

| | |
|---|---|
| **What** | A background process that runs as its own container (`expiration-worker`) from the Inventory Service image |
| **Does** | Every second, finds holds whose expiry time has passed (up to 100 at a time). For each one, it atomically returns the seats and marks the hold `EXPIRED`, then publishes `reservation.expired` with the user's email |
| **Safe to run several copies** | The Lua script re-checks the hold's state, so a hold is expired exactly once even if several workers run |

### 4.5 Order Service (`services/order_service/`)

| | |
|---|---|
| **What** | Consumes RabbitMQ events and keeps the `Order` table in PostgreSQL up to date |
| **Listens to** | `reservation.created` (writes a `PENDING` order), `reservation.confirmed` (sets `CONFIRMED`), `reservation.expired` (sets `PENDING` → `EXPIRED`) |
| **Reliability** | Every write is an idempotent upsert keyed on `reservationId`. A failed message is retried every 5 s, up to 5 attempts, then moved to `order.dlq` |
| **Why it exists** | The Inventory Service also writes orders directly, so "My Bookings" is correct straight away. The Order Service is a safety net that brings Postgres back in line from the event stream if a direct write ever fails |

### 4.6 Notification Service (`services/notification_service/`)

| | |
|---|---|
| **What** | Consumes events and sends emails through Resend |
| **Listens to** | `reservation.confirmed` ("Your booking is confirmed") and `reservation.expired` ("Your reservation has expired") |
| **Reliability** | Processes one message at a time. A failure is retried every 10 s, up to 3 attempts, then moved to `notification.dlq` with the failure reason |
| **Config** | `RESEND_API_KEY`, `EMAIL_FROM` |

### 4.7 Redis: the source of truth for seats

Holds everything that changes on every request and needs to be both atomic and fast: seat counts, event details, reservations, idempotency keys, the expiry schedule, the event index and refresh-token sessions. See [§5](#5-where-data-lives).

### 4.8 PostgreSQL: durable records

Holds **users** (email, password hash, role) and **orders** (one row per reservation, with status `PENDING`, `CONFIRMED` or `EXPIRED`). The schema is managed with Prisma migrations stored in `services/inventory_service/prisma/migrations/`.

### 4.9 RabbitMQ: the event bus

A durable `direct` exchange called `ticket.events`, plus one queue per consumer, each with its own retry and dead-letter queues. See [§6](#6-events-and-messaging). The management UI is at http://localhost:15673.

### 4.10 CI/CD (`.github/workflows/deploy.yaml`)

On every push to `main`:
1. Run the test suite against a Redis service container.
2. If the tests pass, build and push four images to GitHub Container Registry: `ticket-frontend`, `ticket-inventory`, `ticket-order` and `ticket-notification`. Each is tagged `latest` and with the commit SHA.

---

## 5. Where data lives

The general rule: **Redis owns live state, and PostgreSQL owns records.**

### Redis keys

| Key | Holds | Written by |
|---|---|---|
| `inventory:{eventId}` | Seats currently available (an integer) | Admin (set), reserve (−), expiry (+) |
| `event:meta:{eventId}` | Event details as JSON: name, category, icon, date, location, price, type | Admin |
| `events:index` | Set of all event IDs, used to list events without scanning Redis | Admin create/delete, plus a backfill on startup |
| `reservation:{id}` | The hold as JSON: event, user, quantity, status (`RESERVED`, `CONFIRMED` or `EXPIRED`), expiry time | Reserve, confirm, expiry |
| `idempotency:{userId}:{key}` | The reservation ID created for that key. Expires along with the hold | Reserve |
| `reservation:expirations` | Sorted set of reservation IDs, ordered by expiry time | Reserve (add), confirm/expiry (remove) |
| `refresh:{sha256}` | The refresh-token session (`userId`). Only a hash of the token is stored. Expires after 7 days | Login and refresh (create), refresh and logout (delete) |

### PostgreSQL tables

| Table | Columns | Notes |
|---|---|---|
| `User` | `id`, `email` (unique), `passwordHash`, `role` (`USER` / `ADMIN`), timestamps | Admins are promoted manually (see [§12](#12-how-to-use)) |
| `Order` | `id`, `reservationId` (unique), `eventId`, `userId`, `quantity`, `status`, timestamps | The unique `reservationId` is what makes every order write safe to repeat |

---

## 6. Events and messaging

### Events

| Event | Published by | When | Consumed by |
|---|---|---|---|
| `reservation.created` | Inventory Service | Seats are reserved | Order Service |
| `reservation.confirmed` | Inventory Service | The user confirms (includes the user's email) | Order Service, Notification Service |
| `reservation.expired` | Expiration Worker | A hold times out (includes the user's email) | Order Service, Notification Service |

Messages are JSON, persistent, and use the reservation ID as their `messageId`:

```json
{ "eventType": "reservation.confirmed", "reservationId": "3f0c…", "eventId": "concert101",
  "userId": "a1b2…", "email": "user@example.com", "quantity": 2,
  "status": "CONFIRMED", "occurredAt": "2026-11-07T10:00:00.000Z" }
```

### Queues

| Queue | Purpose |
|---|---|
| `order.reservations` | Main queue for the Order Service (all three events) |
| `order.retry` | Holds a failed order message for 5 s, then sends it back to the main queue |
| `order.dlq` | Order messages that failed 5 times, or weren't valid JSON |
| `notification.events` | Main queue for the Notification Service (confirmed and expired events) |
| `notification.retry` | Holds a failed email message for 10 s, then sends it back to the main queue |
| `notification.dlq` | Email messages that failed 3 times |

```mermaid
flowchart LR
    P[Inventory Service<br/>Expiration Worker] --> EX((ticket.events))
    EX --> Q1[[order.reservations]] --> O[Order Service]
    EX --> Q2[[notification.events]] --> N[Notification Service]
    O -- fail --> R1[[order.retry · 5 s]] --> Q1
    O -- 5th fail --> D1[[order.dlq]]
    N -- fail --> R2[[notification.retry · 10 s]] --> Q2
    N -- 3rd fail --> D2[[notification.dlq]]
```

---

## 7. Workflows, step by step

### W1. Register, sign in and stay signed in

```mermaid
sequenceDiagram
    participant UI as Browser
    participant INV as Inventory Service
    participant PG as PostgreSQL
    participant R as Redis
    UI->>INV: POST /api/auth/register {email, password}
    INV->>PG: create User (bcrypt hash, role USER)
    UI->>INV: POST /api/auth/login
    INV->>PG: find user, check password
    INV->>R: store refresh:{hash} (7 days)
    INV-->>UI: {token (15 min), refreshToken, user}
    Note over UI: ~1 min before the token expires
    UI->>INV: POST /api/auth/refresh {refreshToken}
    INV->>R: GETDEL refresh:{hash} (single use)
    INV->>PG: re-read user (role may have changed)
    INV-->>UI: new {token, refreshToken}
```

1. **Register:** the email is normalised and the password hashed with bcrypt. New users always get the `USER` role. The app then signs the user in automatically.
2. **Login:** returns a short-lived **access token** (a JWT, 15 minutes) and a **refresh token** (7 days). Both are kept in the browser.
3. **Every protected request:** sends `Authorization: Bearer <token>`. The server checks the signature, issuer, audience and expiry.
4. **Refresh:** shortly before the access token expires, the app swaps the refresh token for a new pair. The old refresh token is deleted in the same atomic step, so it can't be reused. Because the user is re-read from the database, a role change (for example, being made an admin) takes effect within 15 minutes.
5. **Multiple tabs:** signing in, refreshing or signing out in one tab applies to all open tabs.
6. **Sign out:** the refresh token is revoked on the server and the browser storage is cleared.

### W2. Admin creates or updates an event

1. The admin clicks **+ Add Tickets** (or **✏️ Edit** on a card) and fills in the form.
2. The browser sends `PUT /api/admin/events/{eventId}/inventory`. The server requires a valid token **and** the `ADMIN` role.
3. In one atomic Redis transaction, the server sets `inventory:{eventId}`, stores `event:meta:{eventId}`, and adds the ID to `events:index`.
4. The event appears in the catalogue immediately. Deleting it removes all three keys in the same way.

### W3. Browse events

1. The app calls `GET /api/events`. No sign-in is needed.
2. The server reads every event ID from `events:index`, then fetches all seat counts and all event details with **one `MGET` each**. It returns events that still have seats, sorted by ID.
3. Search and filtering happen in the browser.

### W4. Book tickets (reserve, then confirm)

```mermaid
sequenceDiagram
    autonumber
    participant UI as Browser
    participant INV as Inventory Service
    participant R as Redis
    participant PG as PostgreSQL
    participant MQ as RabbitMQ
    UI->>INV: POST /api/reservations (JWT, Idempotency-Key)
    INV->>R: reserveTicket.lua
    Note right of R: atomically: check seats → decrement →<br/>store hold (RESERVED) → save key → schedule expiry
    INV->>PG: upsert Order (PENDING)
    INV->>MQ: reservation.created
    INV-->>UI: 201 reserved
    UI->>INV: POST /api/reservations/{id}/confirm
    INV->>R: confirmReservation.lua
    Note right of R: atomically: must be RESERVED and not expired →<br/>set CONFIRMED → remove from expiry schedule
    INV->>PG: upsert Order (CONFIRMED)
    INV->>MQ: reservation.confirmed (+ email)
    INV-->>UI: 200 CONFIRMED
```

1. The user picks 1–10 tickets and clicks **Confirm & Pay**. The browser creates a unique `Idempotency-Key`.
2. **Reserve:** a single Lua script runs in Redis without interruption:
   - if this key was already used, it returns the original reservation (a safe retry)
   - otherwise it checks that enough seats are free, and fails with `409` if not
   - it subtracts the seats, stores the hold as `RESERVED` with `expiresAt = now + 30 min`, and adds it to the expiry schedule
3. The server writes a `PENDING` order to Postgres and publishes `reservation.created`. The broker confirms receipt **before** the server replies.
4. **Confirm:** a second Lua script checks that the hold is still `RESERVED` and not expired, then marks it `CONFIRMED` and removes it from the expiry schedule. Confirming twice is harmless.
5. The server updates the order to `CONFIRMED` and publishes `reservation.confirmed` with the user's email.
6. The browser shows a success toast and refreshes the seat counts and "My Bookings".

If the confirm step fails (for example, the network drops), the booking shows as **PENDING** in "My Bookings", with a **Confirm Now** button that works until the hold expires.

### W5. Reservation expiry (abandoned holds)

1. Every second, the Expiration Worker asks Redis for up to 100 holds whose `expiresAt` has passed.
2. For each one, `expireReservation.lua` atomically checks that the hold is still `RESERVED` **and** really expired (using Redis's own clock), returns the seats to `inventory:{eventId}`, and marks the hold `EXPIRED`. A confirmed or already-expired hold is never touched, so seats are returned exactly once.
3. The worker looks up the user's email and publishes `reservation.expired`.

### W6. Order history sync (Order Service)

1. The Order Service receives each `reservation.*` event from `order.reservations` (up to 10 at a time).
2. `created` writes a `PENDING` order, `confirmed` sets `CONFIRMED`, and `expired` changes `PENDING` to `EXPIRED`. All of these writes are idempotent.
3. The message is acknowledged only after the database write succeeds.
4. **On failure**, the message is republished to `order.retry`, which returns it to the main queue after 5 s. After 5 attempts, or immediately for invalid JSON, it goes to `order.dlq` with the reason attached. The original is acknowledged only once that hand-off is confirmed, so nothing is lost.

### W7. Email notifications (Notification Service)

1. The Notification Service receives `confirmed` and `expired` events from `notification.events`, one at a time.
2. It builds the email ("Your Ticket Booking Is Confirmed!" or "Your Ticket Reservation Has Expired") and sends it through Resend.
3. **On failure**, it retries every 10 s, up to 3 attempts, then moves the message to `notification.dlq`. The booking itself is never affected.

### W8. "My Bookings"

1. The app calls `GET /api/orders` with the user's token.
2. The server loads that user's orders from Postgres, newest first.
3. **Self-healing:** for any order still marked `PENDING`, the server checks the hold in Redis. If Redis says `CONFIRMED`, or the hold has expired, the order is corrected on the spot.
4. Each order is returned with its event details (name, date, venue, price) and the total price.

---

## 8. Reliability guarantees

| Risk | What prevents it |
|---|---|
| Two people buy the last seat | Atomic Lua check-and-decrement in Redis |
| A retried request books twice | Per-user `Idempotency-Key`, stored with the hold |
| A hold is expired twice, or a confirmed hold is expired | The Lua script re-checks status and expiry time before returning seats |
| Server clocks disagree | Expiry uses Redis's own clock (`TIME`) |
| An event is lost between services | Publisher confirms, durable queues, persistent messages, and acks after processing |
| An event is processed twice | Idempotent upserts keyed on `reservationId` |
| A message keeps failing | Delayed retry, then a dead-letter queue (both consumers) |
| A stolen refresh token is reused | Single-use rotation with `GETDEL`, revocation on logout, only hashes stored |
| A slow email provider | Emails are sent outside the request path |
| A container restart drops work | Health-gated start-up order, graceful shutdown, `restart: unless-stopped` |

---

## 9. Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 7, Vite 8, Oxlint, Nginx 1.27 |
| Backend | Node.js 22, Express 5 |
| Auth | jsonwebtoken (HS256), bcryptjs, refresh tokens stored in Redis |
| Inventory and sessions | Redis 7 + Lua scripts (node-redis 6) |
| Database | PostgreSQL 17, Prisma 7 with `@prisma/adapter-pg` |
| Messaging | RabbitMQ 4 (amqplib) |
| Email | Resend |
| Testing | Node's built-in test runner (`node --test`) against real Redis |
| Infrastructure | Docker, Docker Compose, GitHub Actions → GHCR |

---

## 10. Project structure

```
zero-downtime-express-api/
├── docker-compose.yml               # 5 app containers + Redis, Postgres, RabbitMQ
├── .env.example                     # Infrastructure credentials for docker compose
├── ARCHITECTURE.md                  # Detailed design + remediation log
├── .github/workflows/deploy.yaml    # CI: test, then build & push images to GHCR
├── ticket-booking-frontend/         # React SPA + Nginx
│   ├── src/
│   │   ├── App.jsx                  # Routes, navbar, booking modal & flow
│   │   ├── pages/                   # Events.jsx, Bookings.jsx
│   │   ├── components/              # EventCard, AuthModal, AdminAddTicketsModal
│   │   ├── context/                 # AuthProvider (sessions, refresh, tab sync)
│   │   ├── services/api.js          # Every backend call
│   │   └── index.css                # Design tokens + shared animations
│   ├── nginx.conf
│   └── Dockerfile                   # Multi-stage: Vite build → Nginx
└── services/
    ├── inventory_service/           # Core API + expiration worker
    │   ├── prisma/                  # schema.prisma + migrations
    │   ├── prisma7.config.ts
    │   ├── src/
    │   │   ├── routes/ controllers/ services/ middleware/ config/
    │   │   ├── scripts/             # reserveTicket / confirmReservation / expireReservation .lua
    │   │   └── workers/             # reservationExpirationWorker.js
    │   └── tests/                   # Lua script integration tests
    ├── order_service/               # Events → Order table (retry + DLQ)
    └── notification_service/        # Events → email (retry + DLQ)
```

---

## 11. Getting started (Docker)

### Prerequisites

- Docker Desktop (or Docker Engine) with Compose v2
- A [Resend](https://resend.com) API key if you want real emails. This is optional; without one, notifications fail and end up in `notification.dlq`.

### Step 1: Create the environment files

```bash
cp services/inventory_service/.env.example    services/inventory_service/.env
cp services/order_service/.env.example        services/order_service/.env
cp services/notification_service/.env.example services/notification_service/.env
```

Then edit them:

- `services/inventory_service/.env`: set `JWT_SECRET` (for example, the output of `openssl rand -hex 32`).
- `services/notification_service/.env`: set `RESEND_API_KEY`, and `EMAIL_FROM` if you have a verified domain.

> `DATABASE_URL`, `REDIS_URL` and `RABBITMQ_URL` are set by `docker-compose.yml`, so in Docker the values in these files are overridden.

**Optional:** to change the Postgres or RabbitMQ credentials, run `cp .env.example .env` in the project root and edit it. Compose falls back to `ticketuser`/`password` and `guest`/`guest`. These only take effect when the data volumes are first created, so after changing them on an existing install you'll need `docker compose down -v`, which **deletes all data**.

### Step 2: Build and start

```bash
docker compose up -d --build
docker compose ps        # wait until redis/postgres/rabbitmq show "healthy"
```

This starts all eight containers: `frontend`, `inventory`, `expiration-worker`, `order`, `notification`, `redis`, `postgres` and `rabbitmq`.

### Step 3: Apply database migrations (first run only)

```bash
docker compose exec inventory npm run migrate:deploy
```

### Step 4: Open the app

| URL | What |
|---|---|
| http://localhost:3000 | TicketHub web app |
| http://localhost:4001/health | Inventory API health |
| http://localhost:15673 | RabbitMQ management UI (`guest` / `guest`) |

| Container | Host port |
|---|---|
| frontend | `3000` |
| inventory | `4001` |
| redis | `6379` |
| postgres | `15433` |
| rabbitmq | `5673` (AMQP), `15673` (UI) |
| order, notification, expiration-worker | not exposed |

---

## 12. How to use

### Create an admin account

There is no admin signup, by design. Register a normal user, then promote them:

1. Open http://localhost:3000, click **Sign In → Register**, and create an account.
2. Promote that account in Postgres:

   ```bash
   docker compose exec postgres psql -U ticketuser -d ticketbooking \
     -c "UPDATE \"User\" SET role='ADMIN' WHERE email='you@example.com';"
   ```

3. Sign out and sign in again, or wait up to 15 minutes for the next automatic refresh. You'll then see an **ADMIN** badge and a **+ Add Tickets** button.

### Add events (admin)

Click **+ Add Tickets**, fill in an event ID (e.g. `concert101`), name, category, date, location, price and seat count, then save. To update or delete an event later, click **✏️ Edit** on its card.

The same thing with the API:

```bash
curl -X PUT http://localhost:4001/api/admin/events/concert101/inventory \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"quantity":100,"name":"Arijit Singh Live","category":"Concert","icon":"🎵",
       "date":"25 Dec 2026","location":"Chennai","price":2999,"type":"General Admission"}'
```

### Book tickets (user)

1. Browse **Events** and click **Book Tickets** on a card. You'll be asked to sign in if you aren't.
2. Choose a quantity (1–10) and click **Confirm & Pay**.
3. Open **My Bookings** to see your orders and their status. If a booking shows **PENDING**, click **Confirm Now** before it expires.
4. If email is configured, a confirmation email arrives within a few seconds.

### End-to-end with curl

```bash
API=http://localhost:4001

# Register and log in
curl -s -X POST $API/api/auth/register -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"supersecret"}'
LOGIN=$(curl -s -X POST $API/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"supersecret"}')
TOKEN=$(echo "$LOGIN" | jq -r .token)
REFRESH=$(echo "$LOGIN" | jq -r .refreshToken)

# See events
curl -s $API/api/events | jq

# Reserve 2 seats (sending the same Idempotency-Key again returns the same reservation)
RES_ID=$(curl -s -X POST $API/api/reservations \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-alice-0001" \
  -d '{"eventId":"concert101","quantity":2}' | jq -r .reservation.reservationId)

# Confirm it
curl -s -X POST $API/api/reservations/$RES_ID/confirm -H "Authorization: Bearer $TOKEN"

# List my orders
curl -s $API/api/orders -H "Authorization: Bearer $TOKEN" | jq

# Refresh the session (the old refresh token stops working)
curl -s -X POST $API/api/auth/refresh -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}" | jq '{token, refreshToken}'
```

---

## 13. Local development

Run only the infrastructure in Docker, and the Node apps on your machine with hot reload.

```bash
docker compose up -d redis postgres rabbitmq
```

The `.env.example` templates already point at the **host** ports (`localhost:6379`, `localhost:5673`, `localhost:15433`), so copying them as in [Step 1](#step-1-create-the-environment-files) is enough. You still need to set `JWT_SECRET` and `RESEND_API_KEY`.

```bash
# Inventory Service (API + migrations + worker)
cd services/inventory_service
npm install
npm run prisma:generate
npm run migrate:deploy              # or migrate:dev when changing the schema
npm run dev                         # API with nodemon on :4001
npm run worker:expiration           # in a second terminal

# Order Service
cd services/order_service
npm install && npm run prisma:generate
npm run dev

# Notification Service
cd services/notification_service
npm install && npm run dev

# Frontend (Vite on :3000, proxies /api → localhost:4001)
cd ticket-booking-frontend
npm install && npm run dev
```

Frontend scripts: `npm run dev`, `npm run build`, `npm run preview`, `npm run lint` (Oxlint).

---

## 14. Configuration

### Inventory Service (and the expiration worker)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `4001` | HTTP port |
| `JWT_SECRET` | **yes** | — | Secret for signing and verifying access tokens |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `REDIS_URL` | no | `redis://localhost:6379` | Redis connection string |
| `RABBITMQ_URL` | no | `amqp://guest:guest@localhost:5672` | RabbitMQ connection string |
| `RESERVATION_TTL_SECONDS` | no | `1800` | How long a hold keeps its seats |
| `REFRESH_TOKEN_TTL_SECONDS` | no | `604800` (7 days) | Refresh token lifetime. Access tokens always last 15 minutes |

### Order Service

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `4002` | Health endpoint port |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `RABBITMQ_URL` | no | `amqp://guest:guest@localhost:5672` | RabbitMQ connection string |

### Notification Service

| Variable | Required | Default | Description |
|---|---|---|---|
| `RABBITMQ_URL` | **yes** | — | RabbitMQ connection string |
| `RESEND_API_KEY` | **yes** for email | — | Resend API key |
| `EMAIL_FROM` | no | `Acme <onboarding@resend.dev>` | Sender address. Use one on a domain verified in Resend to reach any recipient |

### Docker Compose (root `.env`)

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `ticketbooking` / `ticketuser` / `password` | Database settings. **Change the password outside local development** |
| `RABBITMQ_USER` / `RABBITMQ_PASSWORD` | `guest` / `guest` | Broker settings. **Change the password outside local development** |

### Frontend

| Variable | When | Default | Description |
|---|---|---|---|
| `VITE_API_URL` | build time | `""` (same origin) | API base URL. Leave it empty behind Nginx or the Vite proxy. Never use Docker hostnames here, because the browser can't resolve them |
| `VITE_API_TARGET` | dev server | `http://localhost:4001` | Where the Vite dev proxy sends `/api` |

---

## 15. API reference

Base URL: `http://localhost:4001`, or `http://localhost:3000` through Nginx.

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Health check |
| `POST` | `/api/auth/register` | — | Register `{ email, password }` (password 8–72 characters) |
| `POST` | `/api/auth/login` | — | Log in → `{ user, token, refreshToken }` |
| `POST` | `/api/auth/refresh` | `{ refreshToken }` | Get a new `{ token, refreshToken }`. Each refresh token works once |
| `POST` | `/api/auth/logout` | `{ refreshToken }` | Revoke the refresh token (always `204`) |
| `GET` | `/api/auth/me` | Bearer | Current user |
| `GET` | `/api/events` | — | Events with seats available |
| `GET` | `/api/events/:eventId/inventory` | — | Seat count for one event |
| `PUT` | `/api/admin/events/:eventId/inventory` | Admin | Create or update an event and its seats |
| `DELETE` | `/api/admin/events/:eventId/inventory` | Admin | Delete an event |
| `POST` | `/api/reservations` | Bearer + `Idempotency-Key` | Reserve `{ eventId, quantity }` (1–10) |
| `GET` | `/api/reservations/:id` | Owner / Admin | Reservation details |
| `POST` | `/api/reservations/:id/confirm` | Owner / Admin | Confirm a reservation |
| `GET` | `/api/orders` | Bearer | My orders |

| Status | Meaning |
|---|---|
| `201` | Seats reserved |
| `200` | Success, or the existing reservation returned for a repeated idempotency key |
| `400` | Invalid input |
| `401` | Missing or expired token |
| `403` | Wrong role, or not your reservation |
| `404` | Unknown event or reservation |
| `409` | Not enough seats, reservation expired, or email already registered |

See [ARCHITECTURE.md §3.2](ARCHITECTURE.md#32-http-api) for the full error mapping.

---

## 16. Testing

The Inventory Service has integration tests for the three Lua scripts, which hold the system's correctness guarantees. They cover:

- reserving seats
- not enough seats
- an event that was never set up
- a repeated idempotency key
- 20 concurrent requests for 5 seats (no overselling)
- confirming, including confirming twice and rejecting an expired hold
- expiry that returns seats exactly once and never touches confirmed holds

```bash
docker compose up -d redis
cd services/inventory_service
npm install
npm test
```

The tests use Redis **database 15** with a random key prefix and clean up afterwards, so they never touch application data. Point them elsewhere with `TEST_REDIS_URL`. If Redis can't be reached, the tests are **skipped**, not failed. CI runs them before building any images.

---

## 17. Operations and monitoring

```bash
docker compose logs -f inventory expiration-worker order notification   # follow logs
docker compose ps                                                        # health status
docker compose up -d --build inventory                                   # rebuild one service
docker compose down                                                      # stop (keeps data)
docker compose down -v                                                   # stop and DELETE all data
```

- **RabbitMQ UI** (http://localhost:15673):
  - Watch the main queues (`order.reservations`, `notification.events`) and the retry queues.
  - Messages in `order.dlq` and `notification.dlq` carry `x-failure-reason` and `x-retry-count` headers. Once the cause is fixed, replay them with **Move messages**.
- **Redis:**
  ```bash
  docker compose exec redis redis-cli GET inventory:concert101
  docker compose exec redis redis-cli SMEMBERS events:index
  docker compose exec redis redis-cli ZRANGE reservation:expirations 0 -1 WITHSCORES
  ```
- **Postgres:**
  ```bash
  docker compose exec postgres psql -U ticketuser -d ticketbooking \
    -c 'SELECT status, count(*) FROM "Order" GROUP BY status;'
  ```

---

## 18. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `env file ... not found` on `docker compose up` | Copy the three service `.env.example` files to `.env` (Step 1). |
| Postgres or RabbitMQ authentication fails after changing the root `.env` | Credentials only apply when a volume is first created. Run `docker compose down -v` (this **deletes data**), then start again. |
| Inventory exits with `JWT_SECRET is not configured`, or login returns 500 | Set `JWT_SECRET` in `services/inventory_service/.env`. |
| `relation "User" does not exist` | Run the migrations (Step 3). |
| "Inventory has not been initialized" when booking | An admin must create the event first. |
| Seats never come back after abandoned reservations | Check the worker with `docker compose ps expiration-worker` and `docker compose logs expiration-worker`. Seats are released only after `RESERVATION_TTL_SECONDS`. |
| No emails arrive | Check `RESEND_API_KEY`. With the default `onboarding@resend.dev` sender, Resend only delivers to your own account email, so set `EMAIL_FROM` to an address on a verified domain. Check `notification.dlq`. |
| Logged out unexpectedly | The refresh token expired (after 7 days), was revoked by signing out, or was issued before refresh tokens existed. Sign in again. |
| An order stays `PENDING` in Postgres | Check `order.dlq`. "My Bookings" still shows the correct status, because it checks Redis. |
| Port already in use | Change the host side of the port mapping in `docker-compose.yml`. |

---

## 19. Project history and known limitations

Issues found in code review were fixed as **phases**, one issue per phase. Phases 1–10 fix problems without changing the architecture. Phases 11–13 add to it (a new Redis key, new queues, new auth endpoints) without replacing anything. Full details are in [ARCHITECTURE.md §11](ARCHITECTURE.md#11-remediation-phases).

| Phase | Fix | Status |
|---|---|---|
| 1 | Expiration worker runs as a Compose service | ✅ |
| 2 | Sign Out crash fixed | ✅ |
| 3 | CI tests, then builds and pushes every service image | ✅ |
| 4 | `.env.example` for every service | ✅ |
| 5 | Configurable email sender (`EMAIL_FROM`) | ✅ |
| 6 | npm scripts for Prisma migrations | ✅ |
| 7 | Compose credentials come from a root `.env` | ✅ |
| 8 | Client-only "demo mode" bookings removed | ✅ |
| 9 | Unused `src/data/events.jsx` deleted | ✅ |
| 10 | Lua script test suite | ✅ |
| 11 | `GET /api/events` uses an `events:index` set instead of `KEYS` | ✅ |
| 12 | Retry queue and dead-letter queue for the Order Service | ✅ |
| 13 | Rotating refresh tokens, with sessions synced across tabs | ✅ |

**Still open:**

- Refresh tokens live in `localStorage`, so a cross-site scripting bug could read them. An `httpOnly` cookie would be safer but needs cookie and CSRF handling.
- The automated tests cover only the Lua scripts. Tests for the event index, refresh rotation and the Order retry path would need Postgres and RabbitMQ fixtures.
- If a retried `reservation.expired` event reaches the Order Service before its `reservation.created`, the order stays `PENDING` in Postgres. "My Bookings" still shows the correct status because it checks Redis.
