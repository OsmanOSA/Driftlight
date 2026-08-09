import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface FileInspection {
  hash: string;
  lineCount: number;
}

export async function inspectFile(filePath: string): Promise<FileInspection> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    let byteCount = 0;
    let newlineCount = 0;
    let lastByte: number | undefined;
    stream.on("data", (value: string | Buffer) => {
      const chunk = typeof value === "string" ? Buffer.from(value) : value;
      hash.update(chunk);
      byteCount += chunk.length;
      for (const byte of chunk) {
        if (byte === 10) newlineCount += 1;
      }
      if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({
      hash: hash.digest("hex"),
      lineCount: byteCount === 0 ? 0 : newlineCount + (lastByte === 10 ? 0 : 1),
    }));
  });
}

export async function hashFile(filePath: string): Promise<string> {
  return (await inspectFile(filePath)).hash;
}
