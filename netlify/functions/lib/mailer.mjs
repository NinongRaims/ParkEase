// E-mail via SMTP (nodemailer). Without PARKEASE_SMTP_HOST the message is only written to the function log.
import nodemailer from "nodemailer";

const clean = (v) => String(v).split(/\s+/).filter(Boolean).join(" ");
export const isConfigured = () => Boolean(process.env.PARKEASE_SMTP_HOST);

export async function sendMail(to, subject, text, replyTo) {
  const host = process.env.PARKEASE_SMTP_HOST;
  if (!host) {
    console.log(`[ParkEase e-mail - SMTP not configured, not sent]\nTo: ${to}\nSubject: ${subject}\n\n${text}`);
    return false;
  }
  const port = Number(process.env.PARKEASE_SMTP_PORT || 587);
  const security = (process.env.PARKEASE_SMTP_SECURITY || "starttls").toLowerCase();
  const user = process.env.PARKEASE_SMTP_USER;
  try {
    const transport = nodemailer.createTransport({
      host, port, secure: security === "ssl", requireTLS: security === "starttls", ignoreTLS: security === "none",
      auth: user ? { user, pass: process.env.PARKEASE_SMTP_PASSWORD || "" } : undefined,
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000,
    });
    await transport.sendMail({
      from: process.env.PARKEASE_MAIL_FROM || user || "ParkEase <no-reply@localhost>",
      to: clean(to), subject: clean(subject), text,
      ...(replyTo ? { replyTo: clean(replyTo) } : {}),
    });
    return true;
  } catch (err) {
    console.error("Could not send e-mail to", to, err.message);
    return false;
  }
}
