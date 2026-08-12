import { deflateSync, inflateSync } from "node:zlib";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Génère les pastilles de sévérité affichées par les notifications système.
 *
 * Le motif est celui du produit : un voyant allumé. L'image est pleine trame
 * plutôt qu'un disque sur fond transparent, parce que Windows la recadre en
 * cercle (`hint-crop="circle"`) — un disque déjà détouré s'y retrouverait rogné
 * sur ses propres bords. macOS l'affiche carrée, ce qui convient aussi.
 *
 * Le script est versionné à côté des PNG qu'il produit pour que la forme reste
 * modifiable : un binaire commité sans sa source devient intouchable au premier
 * changement de teinte.
 *
 *   node scripts/build-icons.mjs
 */

const SIZE = 256;

const ICONS = [
  {
    name: "driftlight-red.png",
    // Un rouge profond plutôt que vif : il doit alerter sans ressembler à une
    // erreur système, et rester lisible sur fond clair comme sur fond sombre.
    top: [0xff, 0x6b, 0x63],
    bottom: [0xb3, 0x18, 0x12],
    glyph: "bang",
  },
  {
    name: "driftlight-orange.png",
    top: [0xff, 0xc2, 0x4d],
    bottom: [0xc9, 0x6a, 0x05],
    glyph: "bang",
  },
  {
    // Icône d'application : un voyant allumé, sans signe d'alerte. Elle
    // représente l'outil, pas un verdict — l'afficher en rouge donnerait
    // l'impression d'un problème permanent.
    name: "driftlight.png",
    top: [0x3d, 0x4a, 0x5c],
    bottom: [0x1b, 0x22, 0x2e],
    glyph: "lamp",
  },
];

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

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
const mix = (from, to, t) => from + (to - from) * t;

/** Couverture d'une forme sur un pixel, estimée par échantillonnage. */
function coverage(x, y, inside, samples = 4) {
  let hits = 0;
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      if (inside(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples)) hits += 1;
    }
  }
  return hits / (samples * samples);
}

/**
 * Point d'exclamation centré : une barre à coins arrondis surmontant un point.
 * Un glyphe vaut mieux qu'un rond nu — dans un centre de notifications, la
 * couleur seule ne distingue plus rien une fois les pastilles empilées.
 */
function bangCoverage(x, y) {
  const cx = SIZE / 2;
  const barWidth = SIZE * 0.068;
  const barTop = SIZE * 0.235;
  const barBottom = SIZE * 0.60;
  const dotCentre = SIZE * 0.735;
  const dotRadius = SIZE * 0.072;

  const inBar = (px, py) => {
    const dx = Math.abs(px - cx);
    if (dx > barWidth) return false;
    if (py < barTop || py > barBottom) return false;
    // Coins arrondis : on retranche les quarts de disque aux extrémités.
    const radius = barWidth;
    if (py < barTop + radius) {
      const dy = barTop + radius - py;
      return dx * dx + dy * dy <= radius * radius || dx <= barWidth - radius;
    }
    if (py > barBottom - radius) {
      const dy = py - (barBottom - radius);
      return dx * dx + dy * dy <= radius * radius || dx <= barWidth - radius;
    }
    return true;
  };
  const inDot = (px, py) => {
    const dx = px - cx;
    const dy = py - dotCentre;
    return dx * dx + dy * dy <= dotRadius * dotRadius;
  };

  return coverage(x, y, (px, py) => inBar(px, py) || inDot(px, py));
}

/** Voyant allumé : un disque lumineux, entouré d'un halo doux. */
function lampCoverage(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const radius = SIZE * 0.2;
  return coverage(x, y, (px, py) => {
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= radius * radius;
  });
}

/** Halo décroissant autour du voyant, pour qu'il paraisse émettre. */
function lampGlow(x, y) {
  const distance = Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2);
  const inner = SIZE * 0.2;
  const outer = SIZE * 0.42;
  if (distance <= inner) return 0;
  if (distance >= outer) return 0;
  return (1 - (distance - inner) / (outer - inner)) ** 2 * 0.45;
}

function render({ top, bottom, glyph }) {
  const rows = [];
  const centreX = SIZE * 0.34;
  const centreY = SIZE * 0.28;
  const glowRadius = SIZE * 0.62;

  for (let y = 0; y < SIZE; y += 1) {
    const row = Buffer.alloc(1 + SIZE * 4);
    row[0] = 0; // Filtre « None » : la taille ne justifie pas mieux.
    for (let x = 0; x < SIZE; x += 1) {
      // Dégradé vertical : le voyant paraît éclairé par le haut.
      const t = y / (SIZE - 1);
      let red = mix(top[0], bottom[0], t);
      let green = mix(top[1], bottom[1], t);
      let blue = mix(top[2], bottom[2], t);

      // Reflet spéculaire diffus, décalé vers le haut à gauche.
      const dx = x - centreX;
      const dy = y - centreY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const specular = Math.max(0, 1 - distance / glowRadius) ** 2 * 0.28;
      red = mix(red, 255, specular);
      green = mix(green, 255, specular);
      blue = mix(blue, 255, specular);

      // Assombrissement du bord : donne du volume une fois recadré en cercle.
      const edge = Math.max(
        0,
        1 - Math.hypot(x - SIZE / 2, y - SIZE / 2) / (SIZE * 0.72),
      );
      const vignette = 1 - (1 - edge) * 0.35;
      red *= vignette;
      green *= vignette;
      blue *= vignette;

      if (glyph === "lamp") {
        // Halo ambré d'abord, puis le voyant lui-même par-dessus.
        const halo = lampGlow(x, y);
        red = mix(red, 0xff, halo * 0.9);
        green = mix(green, 0xb0, halo * 0.9);
        blue = mix(blue, 0x3c, halo * 0.5);
        const lamp = lampCoverage(x, y);
        red = mix(red, 0xff, lamp);
        green = mix(green, 0xc8, lamp);
        blue = mix(blue, 0x6a, lamp);
      } else {
        // Le glyphe d'alerte est peint en blanc par-dessus le fond.
        const bang = bangCoverage(x, y);
        red = mix(red, 255, bang);
        green = mix(green, 255, bang);
        blue = mix(blue, 255, bang);
      }

      const offset = 1 + x * 4;
      row[offset] = clamp(red);
      row[offset + 1] = clamp(green);
      row[offset + 2] = clamp(blue);
      row[offset + 3] = 255;
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

/**
 * Enveloppe ICO autour du PNG.
 *
 * Le format accepte une image PNG telle quelle depuis Vista, ce qui évite
 * d'écrire un encodeur BMP. Windows lit l'icône du raccourci du menu Démarrer
 * pour l'en-tête de la notification : sans elle, l'outil s'annonce avec l'icône
 * de l'exécutable qui l'a lancé.
 */
function wrapAsIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // réservé
  header.writeUInt16LE(1, 2); // type : icône
  header.writeUInt16LE(1, 4); // une seule image
  const entry = Buffer.alloc(16);
  entry[0] = 0; // largeur 256 se code par zéro
  entry[1] = 0; // hauteur idem
  entry[2] = 0; // palette
  entry[3] = 0; // réservé
  entry.writeUInt16LE(1, 4); // plans
  entry.writeUInt16LE(32, 6); // bits par pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

/** Relit le PNG produit : un asset invalide ferait disparaître la notification. */
async function verify(file) {
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
  const at = (x, y) => {
    const offset = y * stride + 1 + x * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
  };
  const [, , , alpha] = at(2, 2);
  if (alpha !== 255) throw new Error(`${file} : l'image doit être pleine trame.`);
  const [gr, gg, gb] = at(SIZE / 2, Math.round(SIZE * 0.5));
  const [br] = at(Math.round(SIZE * 0.06), Math.round(SIZE * 0.5));
  if (gr <= br || gg + gb === 0) throw new Error(`${file} : le glyphe central ne ressort pas du fond.`);
  if (br > 250) throw new Error(`${file} : le fond ne devrait pas être blanc.`);
  return buffer.length;
}

const directory = path.resolve("assets");
await mkdir(directory, { recursive: true });
for (const icon of ICONS) {
  const file = path.join(directory, icon.name);
  const png = render(icon);
  await writeFile(file, png);
  const size = await verify(file);
  console.log(`✓ ${icon.name} — ${SIZE}×${SIZE}, ${size} octets, relu et vérifié`);
  if (icon.glyph === "lamp") {
    const ico = path.join(directory, "driftlight.ico");
    await writeFile(ico, wrapAsIco(png));
    console.log(`✓ driftlight.ico — enveloppe ICO autour du même PNG`);
  }
}
