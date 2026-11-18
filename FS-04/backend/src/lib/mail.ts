import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";
import { logger } from "./logger.js";

// Email. EMAIL_TRANSPORT=console prints messages to the worker log (the default, as v1's console backend did),
// json keeps them in `outbox` (tests), and an smtp:// URL sends them for real.

export interface Mail {
  to: string[];
  subject: string;
  text: string;
}

export const outbox: Mail[] = [];
let transporter: Transporter | undefined;

export async function sendMail(mail: Mail): Promise<void> {
  if (!mail.to.length) return;
  const mode = config.EMAIL_TRANSPORT;
  if (mode === "json") {
    outbox.push(mail);
    return;
  }
  if (mode === "console") {
    logger.info({ to: mail.to, subject: mail.subject }, `email\n${mail.text}`);
    return;
  }
  transporter ??= nodemailer.createTransport(mode);
  try {
    await transporter.sendMail({ from: config.DEFAULT_FROM_EMAIL, ...mail });
  } catch (err) {
    // Like v1 (fail_silently): a mail server problem must not fail the job that triggered the email.
    logger.warn({ err, subject: mail.subject }, "email not sent");
  }
}
