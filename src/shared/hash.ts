import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
