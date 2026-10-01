import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";

export interface UploadedFilePart {
  filename: string;
  data: Buffer;
}

export async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function parseMultipartFile(body: Buffer, boundary: string): UploadedFilePart | undefined {
  const delimiter = Buffer.from(`--${boundary}`);
  let offset = 0;

  while (offset < body.length) {
    const start = body.indexOf(delimiter, offset);
    if (start === -1) break;

    const headerStart = start + delimiter.length + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;

    const headers = body.slice(headerStart, headerEnd).toString("utf8");
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delimiter, dataStart);
    if (next === -1) break;

    if (filenameMatch) {
      const dataEnd = next - 2;
      return {
        filename: basename(filenameMatch[1]),
        data: body.slice(dataStart, dataEnd)
      };
    }

    offset = next;
  }

  return undefined;
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

export function sendText(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache"
  });
  response.end(body);
}

export async function sendFile(
  response: ServerResponse,
  path: string,
  options: {
    contentType: string;
    disposition?: "inline" | "attachment";
    cacheControl?: string;
  }
): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) return false;
  } catch {
    return false;
  }

  const headers: Record<string, string> = {
    "Content-Type": options.contentType
  };
  if (options.cacheControl) {
    headers["Cache-Control"] = options.cacheControl;
  }
  if (options.disposition) {
    headers["Content-Disposition"] = `${options.disposition}; filename="${basename(path)}"`;
  }

  response.writeHead(200, headers);
  createReadStream(path).pipe(response);
  return true;
}
