import net from "node:net";
import tls from "node:tls";

interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  from: string[];
  subjectContains?: string;
  attachmentPatterns: string[];
}

export interface EmailWorkbook {
  filename: string;
  content: Buffer;
  subject?: string;
  from?: string;
  messageId: number;
}

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

export function imapConfigured(): boolean {
  return Boolean(getImapConfig());
}

export async function findInputWorkbookEmail(): Promise<EmailWorkbook | undefined> {
  const config = getImapConfig();
  if (!config) {
    throw new Error("IMAP settings are not configured.");
  }

  const imap = new ImapConnection(
    config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port })
  );

  try {
    await imap.expectGreeting();
    await imap.command(`LOGIN ${quote(config.user)} ${quote(config.password)}`, "OK");
    await imap.command(`SELECT ${quoteMailbox(config.mailbox)}`, "OK");

    const messageIds = parseSearchIds(await imap.command("SEARCH UNSEEN", "OK")).reverse().slice(0, 25);
    for (const messageId of messageIds) {
      const rawMessage = await imap.fetchMessage(messageId);
      const workbook = extractWorkbook(rawMessage, messageId, config);
      if (workbook) {
        await imap.command(`STORE ${messageId} +FLAGS (\\Seen)`, "OK");
        return workbook;
      }
    }

    return undefined;
  } finally {
    await imap.close();
  }
}

function getImapConfig(): ImapConfig | undefined {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;

  if (!host || !user || !password) return undefined;

  return {
    host,
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: process.env.IMAP_SECURE !== "false",
    user,
    password,
    mailbox: process.env.IMAP_MAILBOX ?? "INBOX",
    from: parseList(process.env.INPUT_EMAIL_FROM),
    subjectContains: process.env.INPUT_EMAIL_SUBJECT_CONTAINS,
    attachmentPatterns: parseAttachmentPatterns(process.env.INPUT_EMAIL_ATTACHMENT_NAME)
  };
}

function extractWorkbook(rawMessage: string, messageId: number, config: ImapConfig): EmailWorkbook | undefined {
  const { headers, body } = splitHeadersAndBody(rawMessage);
  const from = decodeHeader(headers.from ?? "");
  const subject = decodeHeader(headers.subject ?? "");

  if (
    config.from.length > 0 &&
    !config.from.some((sender) => from.toLowerCase().includes(sender.toLowerCase()))
  ) {
    return undefined;
  }

  if (config.subjectContains && !subject.toLowerCase().includes(config.subjectContains.toLowerCase())) {
    return undefined;
  }

  for (const part of flattenMimeParts(headers, body)) {
    const filename = attachmentFilename(part.headers);
    if (!filename) continue;

    if (!filenameMatchesAnyPattern(filename, config.attachmentPatterns)) continue;

    const encoding = (part.headers["content-transfer-encoding"] ?? "").toLowerCase();
    const content = encoding === "base64"
      ? Buffer.from(part.body.replace(/\s/g, ""), "base64")
      : Buffer.from(part.body, "utf8");

    return {
      filename,
      content,
      subject,
      from,
      messageId
    };
  }

  return undefined;
}

function parseAttachmentPatterns(value: string | undefined): string[] {
  const patterns = parseList(value ?? "ListToCheck.xlsx");

  return patterns.length > 0 ? patterns : ["ListToCheck.xlsx"];
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function filenameMatchesAnyPattern(filename: string, patterns: string[]): boolean {
  return patterns.some((pattern) => wildcardToRegExp(pattern).test(filename));
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function flattenMimeParts(headers: Record<string, string>, body: string): MimePart[] {
  const contentType = headers["content-type"] ?? "";
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!boundary) return [{ headers, body }];

  const parts: MimePart[] = [];
  const delimiter = `--${boundary}`;
  for (const section of body.split(delimiter)) {
    const trimmed = section.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (!trimmed || trimmed.startsWith("--")) continue;

    const part = splitHeadersAndBody(trimmed);
    parts.push(...flattenMimeParts(part.headers, part.body));
  }

  return parts;
}

function splitHeadersAndBody(message: string): { headers: Record<string, string>; body: string } {
  const separator = message.search(/\r?\n\r?\n/);
  const headerText = separator === -1 ? message : message.slice(0, separator);
  const body = separator === -1 ? "" : message.slice(message.indexOf("\n", separator + 1) + 1);
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};

  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  return { headers, body };
}

function attachmentFilename(headers: Record<string, string>): string | undefined {
  const disposition = headers["content-disposition"] ?? "";
  const contentType = headers["content-type"] ?? "";
  const filename =
    disposition.match(/filename\*?=(?:"([^"]+)"|([^;]+))/i)?.[1] ??
    disposition.match(/filename\*?=(?:"([^"]+)"|([^;]+))/i)?.[2] ??
    contentType.match(/name\*?=(?:"([^"]+)"|([^;]+))/i)?.[1] ??
    contentType.match(/name\*?=(?:"([^"]+)"|([^;]+))/i)?.[2];

  return filename ? decodeHeader(filename.trim()) : undefined;
}

function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_match, charset: string, encoding: string, text: string) => {
    const buffer = encoding.toUpperCase() === "B"
      ? Buffer.from(text, "base64")
      : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_hexMatch: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "binary");

    return charset.toLowerCase() === "utf-8" ? buffer.toString("utf8") : buffer.toString();
  }).replace(/^utf-8''/i, "");
}

function parseSearchIds(response: string): number[] {
  return response
    .split(/\r?\n/)
    .find((line) => line.startsWith("* SEARCH"))
    ?.replace("* SEARCH", "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite) ?? [];
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteMailbox(value: string): string {
  return quote(value);
}

class ImapConnection {
  private buffer = "";
  private tagNumber = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly socket: net.Socket | tls.TLSSocket) {
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("binary");
      for (const notify of this.waiters.splice(0)) {
        notify();
      }
    });
  }

  async expectGreeting(): Promise<void> {
    await this.readUntil((text) => /^\* OK/m.test(text));
  }

  async command(command: string, expectedStatus: string): Promise<string> {
    const tag = `A${(++this.tagNumber).toString().padStart(4, "0")}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const response = await this.readUntil((text) => new RegExp(`^${tag} `, "m").test(text));
    if (!new RegExp(`^${tag} ${expectedStatus}\\b`, "m").test(response)) {
      throw new Error(`IMAP command failed: ${response}`);
    }
    return response;
  }

  async fetchMessage(messageId: number): Promise<string> {
    const response = await this.command(`FETCH ${messageId} BODY.PEEK[]`, "OK");
    const literalMatch = response.match(/\{(\d+)\}\r?\n/);
    if (!literalMatch) {
      throw new Error(`Could not read message ${messageId} from IMAP response.`);
    }

    const start = response.indexOf(literalMatch[0]) + literalMatch[0].length;
    return response.slice(start, start + Number(literalMatch[1]));
  }

  async close(): Promise<void> {
    try {
      await this.command("LOGOUT", "OK");
    } catch {
      // Closing the socket is enough during error cleanup.
    }
    this.socket.end();
  }

  private async readUntil(done: (text: string) => boolean): Promise<string> {
    while (!done(this.buffer)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    const text = this.buffer;
    this.buffer = "";
    return text;
  }
}
