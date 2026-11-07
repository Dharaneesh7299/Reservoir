
const {
  getChannel,
  getPublisherChannel,
  QUEUE,
  RETRY_EXCHANGE,
  DLX_EXCHANGE,
} = require("../config/rabbitmq");
const prisma = require("../config/prisma");

// Total processing attempts before a message is sent to the DLQ.
const MAX_ATTEMPTS = 5;

async function applyEvent(event) {
  switch (event.eventType) {
    case "reservation.created": {
      await prisma.order.upsert({
        where: {
          reservationId: event.reservationId,
        },
        update: {},
        create: {
          reservationId: event.reservationId,
          eventId: event.eventId,
          userId: event.userId,
          quantity: event.quantity,
          status: "PENDING",
        },
      });

      console.log(
        "Order created or already exists:",
        event.reservationId
      );
      break;
    }

    case "reservation.confirmed": {
      const result = await prisma.order.upsert({
        where: {
          reservationId: event.reservationId,
        },
        update: {
          status: "CONFIRMED",
        },
        create: {
          reservationId: event.reservationId,
          eventId: event.eventId,
          userId: event.userId,
          quantity: event.quantity,
          status: "CONFIRMED",
        },
      });

      console.log(
        "Order confirmed:",
        event.reservationId,
        "Status:",
        result.status
      );
      break;
    }

    case "reservation.expired": {
      const result = await prisma.order.updateMany({
        where: {
          reservationId: event.reservationId,
          status: "PENDING",
        },
        data: {
          status: "EXPIRED",
        },
      });

      console.log(
        "Order expired:",
        event.reservationId,
        "Updated:",
        result.count
      );
      break;
    }

    default:
      console.log("Ignoring unknown event:", event.eventType);
  }
}

function publishAndConfirm(publisher, exchange, routingKey, message, headers) {
  return new Promise((resolve, reject) => {
    publisher.publish(
      exchange,
      routingKey,
      message.content,
      {
        persistent: true,
        contentType: message.properties.contentType,
        type: message.properties.type,
        messageId: message.properties.messageId,
        headers: {
          ...message.properties.headers,
          ...headers,
        },
      },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

async function startReservationConsumer() {
  const channel = await getChannel();
  const publisher = getPublisherChannel();

  await channel.prefetch(10);

  await channel.consume(
    QUEUE,
    async (message) => {
      if (!message) return;

      const previousAttempts = Number(
        message.properties.headers?.["x-retry-count"] || 0
      );

      let event;

      try {
        event = JSON.parse(message.content.toString());
      } catch (parseError) {
        // A malformed message will never succeed: dead-letter it immediately.
        await handOff(channel, publisher, message, {
          toDlq: true,
          attempt: previousAttempts + 1,
          reason: `Invalid JSON: ${parseError.message}`,
        });
        return;
      }

      try {
        console.log(
          "Received reservation event:",
          event.eventType,
          `(attempt ${previousAttempts + 1}/${MAX_ATTEMPTS})`
        );

        await applyEvent(event);

        // Acknowledge only after successful processing.
        channel.ack(message);
      } catch (error) {
        console.error(
          "Failed to process reservation event:",
          error?.message || String(error)
        );

        const attempt = previousAttempts + 1;

        await handOff(channel, publisher, message, {
          toDlq: attempt >= MAX_ATTEMPTS,
          attempt,
          reason: error?.message || String(error),
        });
      }
    },
    {
      noAck: false,
    }
  );

  console.log(`Reservation consumer started on queue: ${QUEUE}`);
}

// Move a failed message to the retry queue or DLQ, then ack the original.
// If the hand-off itself fails, requeue the original so nothing is lost.
async function handOff(channel, publisher, message, { toDlq, attempt, reason }) {
  try {
    if (toDlq) {
      console.error(
        `Sending ${message.properties.messageId || "message"} to DLQ after ${attempt} attempt(s)`
      );

      await publishAndConfirm(publisher, DLX_EXCHANGE, "failed", message, {
        "x-retry-count": attempt,
        "x-failure-reason": reason,
      });
    } else {
      console.log(`Scheduling retry ${attempt + 1}/${MAX_ATTEMPTS}`);

      await publishAndConfirm(publisher, RETRY_EXCHANGE, "retry", message, {
        "x-retry-count": attempt,
      });
    }

    channel.ack(message);
  } catch (publishError) {
    console.error(
      "Failed to publish retry/DLQ message:",
      publishError?.message || String(publishError)
    );

    channel.nack(message, false, true);
  }
}

module.exports = {
  startReservationConsumer,
};
