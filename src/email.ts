import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import net from "node:net";
import tls from "node:tls";
import type { OutputPaths } from "./types.js";

interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  recipients: string[];
}

interface EmailResultsOptions {
  outputPaths: OutputPaths;
  runId: string;
  baseUrl: string;
  canceled: boolean;
  sendCount: number;
  doNotSendCount: number;
  courseFrequencyCount: number;
}

interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export function emailConfigured(): boolean {
  return Boolean(getEmailConfig());
}

export async function emailRunResults(options: EmailResultsOptions): Promise<void> {
  const config = getEmailConfig();
  if (!config) return;

  const attachments: Attachment[] = await Promise.all([
    attachment(options.outputPaths.sendPath),
    attachment(options.outputPaths.doNotSendPath),
    attachment(options.outputPaths.coursesAlreadyTakenPath)
  ]);

  const message = buildMessage(config, options, attachments);
  await sendSmtp(config, message);
}

function getEmailConfig(): EmailConfig | undefined {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.EMAIL_FROM ?? user;
  const recipients = (process.env.EMAIL_RECIPIENTS ?? "")
    .split(",")
    .map((recipient) => recipient.trim())
    .filter(Boolean);

  if (!host || !user || !password || !from || recipients.length === 0) {
    return undefined;
  }

  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    user,
    password,
    from,
    recipients
  };
}

async function attachment(path: string): Promise<Attachment> {
  return {
    filename: basename(path),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content: await readFile(path)
  };
}

function buildMessage(config: EmailConfig, options: EmailResultsOptions, attachments: Attachment[]): string {
  const boundary = `----license-status-${Date.now().toString(36)}`;
  const subject = `${options.canceled ? "Stopped" : "Complete"} license status checker results`;
  const logLinks = [
    ["Expired log", fileUrl(options.baseUrl, options.runId, "expired")],
    ["Greater-than-90 log", fileUrl(options.baseUrl, options.runId, "greaterThan90")],
    ["Exception log", fileUrl(options.baseUrl, options.runId, "exception")],
    ["Timing log", fileUrl(options.baseUrl, options.runId, "timings")]
  ];
  const html = [
    `<p>The license status checker run ${options.canceled ? "was stopped" : "finished successfully"}.</p>`,
    "<ul>",
    `<li>Send rows: ${options.sendCount}</li>`,
    `<li>Do-not-send rows: ${options.doNotSendCount}</li>`,
    `<li>Course frequency rows: ${options.courseFrequencyCount}</li>`,
    "</ul>",
    "<p>Log files:</p>",
    "<ul>",
    ...logLinks.map(([label, href]) => `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`),
    "</ul>",
    "<p>The Excel output files are attached.</p>"
  ].join("");

  const headers = [
    `From: ${config.from}`,
    `To: ${config.recipients.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];

  const parts = [
    ...headers,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(html),
    ...attachments.flatMap((file) => [
      `--${boundary}`,
      `Content-Type: ${file.contentType}; name="${file.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${file.filename}"`,
      "",
      wrapBase64(file.content.toString("base64"))
    ]),
    `--${boundary}--`,
    ""
  ];

  return parts.join("\r\n");
}

async function sendSmtp(config: EmailConfig, message: string): Promise<void> {
  let socket: net.Socket | tls.TLSSocket = config.secure
    ? tls.connect({ host: config.host, port: config.port, servername: config.host })
    : net.connect({ host: config.host, port: config.port });

  const smtp = new SmtpConnection(socket);
  await smtp.expect(220);
  await smtp.command(`EHLO ${hostnameForEhlo()}`, 250);

  if (!config.secure) {
    await smtp.command("STARTTLS", 220);
    socket = tls.connect({ socket, servername: config.host });
    smtp.replaceSocket(socket);
    await smtp.command(`EHLO ${hostnameForEhlo()}`, 250);
  }

  await smtp.command("AUTH LOGIN", 334);
  await smtp.command(Buffer.from(config.user).toString("base64"), 334);
  await smtp.command(Buffer.from(config.password).toString("base64"), 235);
  await smtp.command(`MAIL FROM:<${config.from}>`, 250);
  for (const recipient of config.recipients) {
    await smtp.command(`RCPT TO:<${recipient}>`, 250);
  }
  await smtp.command("DATA", 354);
  await smtp.command(`${dotStuff(message)}\r\n.`, 250);
  await smtp.command("QUIT", 221);
  socket.end();
}

class SmtpConnection {
  private buffer = "";
  private waiters: Array<() => void> = [];

  constructor(private socket: net.Socket | tls.TLSSocket) {
    this.bind(socket);
  }

  replaceSocket(socket: net.Socket | tls.TLSSocket): void {
    this.socket.removeAllListeners("data");
    this.socket = socket;
    this.bind(socket);
  }

  async command(command: string, expectedCode: number): Promise<void> {
    this.socket.write(`${command}\r\n`);
    await this.expect(expectedCode);
  }

  async expect(expectedCode: number): Promise<void> {
    const response = await this.readResponse();
    if (response.code !== expectedCode) {
      throw new Error(`SMTP command failed with ${response.code}: ${response.text}`);
    }
  }

  private bind(socket: net.Socket | tls.TLSSocket): void {
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      for (const notify of this.waiters.splice(0)) {
        notify();
      }
    });
  }

  private async readResponse(): Promise<{ code: number; text: string }> {
    while (true) {
      const response = this.tryReadResponse();
      if (response) return response;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private tryReadResponse(): { code: number; text: string } | undefined {
    const lineEnd = this.buffer.lastIndexOf("\r\n");
    if (lineEnd === -1) return undefined;

    const text = this.buffer.slice(0, lineEnd);
    const lines = text.split("\r\n");
    const last = lines[lines.length - 1];
    if (!/^\d{3} /.test(last)) return undefined;

    this.buffer = this.buffer.slice(lineEnd + 2);
    return {
      code: Number(last.slice(0, 3)),
      text
    };
  }
}

function fileUrl(baseUrl: string, runId: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}/runs/${runId}/files/${key}`;
}

function encodeHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function encodeQuotedPrintable(value: string): string {
  return value
    .replace(/=/g, "=3D")
    .replace(/\r?\n/g, "\r\n")
    .replace(/[^\S\r\n]+$/gm, (match) =>
      match
        .split("")
        .map((char) => `=${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
        .join("")
    );
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function dotStuff(value: string): string {
  return value.replace(/^\./gm, "..");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hostnameForEhlo(): string {
  return "localhost";
}
