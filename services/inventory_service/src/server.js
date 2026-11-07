
require("dotenv").config();

const app = require("./app");
const redis = require("./config/redis");
const {
  connectRabbitMQ,
  setupReservationMessaging,
} = require("./config/rabbitmq");

const PORT = Number(process.env.PORT || 4001);

async function startServer() {
  let server;

  try {
    // Connect to Redis.
    await redis.connect();
    await redis.ping();
    console.log("Connected to Redis");

    // Index events created before the events:index set existed (idempotent).
    const { backfillEventIndex } = require("./services/inventoryService");
    const indexed = await backfillEventIndex();
    if (indexed > 0) {
      console.log(`Backfilled ${indexed} event(s) into events:index`);
    }

    // Connect to RabbitMQ and declare messaging resources.
    await connectRabbitMQ();
    await setupReservationMessaging();

    // Start Express only after dependencies are ready.
    server = app.listen(PORT, () => {
      console.log(`Inventory service running on port ${PORT}`);
    });

    async function shutdown() {
      console.log("Shutting down inventory service...");

      server.close(async () => {
        try {
          const { closeRabbitMQ } = require("./config/rabbitmq");

          await closeRabbitMQ();

          if (redis.isOpen) {
            await redis.quit();
          }

          process.exit(0);
        } catch (error) {
          console.error("Shutdown error:", error.message);
          process.exit(1);
        }
      });
    }

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error) {
    console.error("Failed to start service:", error.message);

    const { closeRabbitMQ } = require("./config/rabbitmq");

    await closeRabbitMQ().catch(() => {});

    if (redis.isOpen) {
      await redis.quit().catch(() => {});
    }

    process.exit(1);
  }
}

startServer();
