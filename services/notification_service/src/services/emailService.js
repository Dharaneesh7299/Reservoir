
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

// Must be an address on a domain verified in Resend to reach arbitrary recipients.
const EMAIL_FROM = process.env.EMAIL_FROM || "Acme <onboarding@resend.dev>";

async function sendEmail({ to, subject, text }) {
    console.log("Sending email to:", to);

    const { data, error } = await resend.emails.send({
        from: EMAIL_FROM,
        to: [to],
        subject,
        text,
    });

    if (error) {
        console.error("Resend email error:", error);
        throw new Error(error.message || "Email delivery failed");
    }

    console.log("Email accepted by Resend:", data.id);

    return data;
}

module.exports = { sendEmail };
