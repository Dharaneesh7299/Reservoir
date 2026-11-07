
const { sendEmail } = require("./emailService");

async function sendNotification(event) {
    const {
        eventType,
        reservationId,
        email,
        quantity,
    } = event;

    if (!email) {
        throw new Error(
            `Recipient email missing for ${reservationId}`
        );
    }

    let subject;
    let text;

    switch (eventType) {
        case "reservation.confirmed":
            subject = "Your Reservoir booking is confirmed";
            text =
                `Your reservation has been confirmed.\n\n` +
                `Reservation ID: ${reservationId}\n` +
                `Tickets: ${quantity}\n\n` +
                `Thank you for booking with us!`;
            break;

        case "reservation.expired":
            subject = "Your Reservoir reservation has expired";
            text =
                `Your reservation has expired.\n\n` +
                `Reservation ID: ${reservationId}\n\n` +
                `Please create a new reservation if you still ` +
                `wish to book tickets.`;
            break;

        default:
            // Ignore events that are not notification events.
            return;
    }

    await sendEmail({
        to: email,
        subject,
        text,
    });

    console.log(`Email sent successfully to ${email}`);
}

module.exports = { sendNotification };
