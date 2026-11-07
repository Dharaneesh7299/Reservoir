
const amqp = require("amqplib");

const QUEUE = "order.reservations";

// Delayed retry: messages wait in RETRY_QUEUE, then dead-letter back to QUEUE.
const RETRY_EXCHANGE = "order.retry.exchange";
const RETRY_QUEUE = "order.retry";
const RETRY_DELAY_MS = 5000;

// Messages that keep failing are parked here for inspection.
const DLX_EXCHANGE = "order.dlx";
const DLQ = "order.dlq";

let connection;
let channel;
let publisherChannel;

async function connectRabbitMQ() {
  if (channel) return channel;

  const url =
    process.env.RABBITMQ_URL ||
    "amqp://guest:guest@localhost:5672";

  connection = await amqp.connect(url);
  channel = await connection.createChannel();
  // Confirm channel so a retry/DLQ hand-off is acknowledged by the broker
  // before the original message is acked.
  publisherChannel = await connection.createConfirmChannel();

  connection.on("error", (error) => {
    console.error("RabbitMQ connection error:", error.message);
  });

  connection.on("close", () => {
    connection = null;
    channel = null;
    publisherChannel = null;
  });

  // Main queue: same arguments as the Inventory Service declares, so both
  // services can assert it without a PRECONDITION_FAILED error.
  await channel.assertQueue(QUEUE, { durable: true });

  await channel.assertExchange(RETRY_EXCHANGE, "direct", { durable: true });
  await channel.assertQueue(RETRY_QUEUE, {
    durable: true,
    arguments: {
      "x-message-ttl": RETRY_DELAY_MS,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": QUEUE,
    },
  });
  await channel.bindQueue(RETRY_QUEUE, RETRY_EXCHANGE, "retry");

  await channel.assertExchange(DLX_EXCHANGE, "direct", { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX_EXCHANGE, "failed");

  console.log("Order Service connected to RabbitMQ");
  console.log(`Main queue: ${QUEUE} | Retry: ${RETRY_QUEUE} | DLQ: ${DLQ}`);

  return channel;
}

async function getChannel() {
  if (!channel) {
    return connectRabbitMQ();
  }

  return channel;
}

function getPublisherChannel() {
  if (!publisherChannel) {
    throw new Error("RabbitMQ publisher channel is not initialized");
  }

  return publisherChannel;
}

module.exports = {
  connectRabbitMQ,
  getChannel,
  getPublisherChannel,
  QUEUE,
  RETRY_EXCHANGE,
  DLX_EXCHANGE,
};
