import { deflateSync, inflateSync } from "node:zlib";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Génère les pastilles de sévérité affichées par les notifications système.
 *
 * Le motif est celui du produit : un voyant allumé. Le script est versionné à
 * côté des PNG qu'il produit pour que la forme reste modifiable — un binaire
 * commité sans sa source devient intouchable au premier changement de teinte.
 *
 *   node scripts/build-icons.mjs
 */

const SIZE = 128;
const SAMPLES = 4; // Supersampling : sans lui, le cercle est crénelé à 48 px.

const ICONS = [
  { name: "driftlight-red.png", rgb: [0xe1, 0x3d, 0x3d] },
  { name: "driftlight-orange.png", rgb: [0xe5, 0x8e, 0x26] },
];

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Couverture du disque sur un pixel, estimée par supersampling. */
function coverage(x, y, centre, radius) {
  let inside = 0;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const px = x + (sx + 0.5) / SAMPLES - centre;
      const py = y + (sy + 0.5) / SAMPLES - centre;
      if (px * px + py * py <= radius * radius) inside += 1;
    }
  }
  return inside / (SAMPLES * SAMPLES);
}

function render([red, green, blue]) {
  const centre = SIZE / 2;
  const radius = SIZE * 0.42;
  const rows = [];
  for (let y = 0; y < SIZE; y += 1) {
    const row = Buffer.alloc(1 + SIZE * 4);
    row[0] = 0; // Filtre « None » : la taille ne justifie pas mieux.
    for (let x = 0; x < SIZE; x += 1) {
      const alpha = coverage(x, y, centre, radius);
      // Un dégradé vertical léger suffit à faire lire une lampe plutôt qu'un rond.
      const lift = 1 + 0.18 * (1 - y / SIZE);
      const offset = 1 + x * 4;
      row[offset] = Math.min(255, Math.round(red * lift));
      row[offset + 1] = Math.min(255, Math.round(green * lift));
      row[offset + 2] = Math.min(255, Math.round(blue * lift));
      row[offset + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // profondeur
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Relit le PNG produit : un asset invalide ferait disparaître la notification. */
async function verify(file, [red]) {
  const buffer = await readFile(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error(`${file} : signature PNG absente.`);
  if (buffer.readUInt32BE(16) !== SIZE || buffer.readUInt32BE(20) !== SIZE) {
    throw new Error(`${file} : dimensions inattendues.`);
  }
  const start = 8 + 4 + 4 + 13 + 4;
  const idatLength = buffer.readUInt32BE(start);
  const pixels = inflateSync(buffer.subarray(start + 8, start + 8 + idatLength));
  const stride = 1 + SIZE * 4;
  const centre = (SIZE / 2) * stride + 1 + (SIZE / 2) * 4;
  if (pixels[centre + 3] !== 255) throw new Error(`${file} : le centre du voyant n'est pas opaque.`);
  if (Math.abs(pixels[centre] - red) > 40) throw new Error(`${file} : teinte centrale inattendue.`);
  if (pixels[1 + 3] !== 0) throw new Error(`${file} : le coin devrait être transparent.`);
  return buffer.length;
}

const directory = path.resolve("assets");
await mkdir(directory, { recursive: true });
for (const icon of ICONS) {
  const file = path.join(directory, icon.name);
  await writeFile(file, render(icon.rgb));
  const size = await verify(file, icon.rgb);
  console.log(`✓ ${icon.name} — ${SIZE}×${SIZE}, ${size} octets, relu et vérifié`);
}
