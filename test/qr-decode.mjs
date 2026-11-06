// Renders QR codes from docs/js/qr.js to PNG files and reads them back with zbarimg, an independent decoder.
// Usage: node test/qr-decode.mjs <out dir> [module path]
// The optional module path lets a deliberately broken copy be checked: it must FAIL, or this check proves nothing.
// Exits 0 only when every sample decodes to exactly its text.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = resolve(process.argv[2] || 'tmp-qr');
const MOD = resolve(process.argv[3] || new URL('../docs/js/qr.js', import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
const { qrMatrix } = await import(pathToFileURL(MOD).href);

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(matrix, scale = 6, quiet = 4) {
  const n = (matrix.length + quiet * 2) * scale;
  const rows = [];
  for (let y = 0; y < n; y++) {
    const row = Buffer.alloc(n + 1);
    for (let x = 0; x < n; x++) {
      const my = Math.floor(y / scale) - quiet;
      const mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && mx >= 0 && my < matrix.length && mx < matrix.length && matrix[my][mx];
      row[x + 1] = dark ? 0 : 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const samples = [
  'K',
  'https://kuza.swiftbotlab.workers.dev/',
  'https://kuza.swiftbotlab.workers.dev/?j=mNQ329CGXGGYH2DNLD7ALAQGMFHU8SJ5U8DKM.64ru59.2aovcow.20270301.RW1lcmdlbmN5IGZ1bmQ',
  'https://kuza.swiftbotlab.workers.dev/?j=tNQ049HH5CHSLUVHGDEP4GBA1R1MGBPT0XEY9V.abc234.1.._Y_wv5-Z8J-T-iL6Ri2l7z-L6Rrv-OfgeWkuOlp-awj-eWkueOplOWkoQ',
  'Shule ya Amani: ada ya mwaka, Jumamosi 7 Novemba. Asante sana kwa mchango wako! ✓',
  'x'.repeat(14), 'x'.repeat(15), 'x'.repeat(26), 'x'.repeat(27), 'x'.repeat(42), 'x'.repeat(43), 'x'.repeat(62), 'x'.repeat(63),
  'y'.repeat(84), 'y'.repeat(85), 'y'.repeat(106), 'y'.repeat(107), 'z'.repeat(122), 'z'.repeat(123), 'z'.repeat(152), 'z'.repeat(153),
  'q'.repeat(180), 'q'.repeat(181), 'q'.repeat(213), 'q'.repeat(214), 'w'.repeat(251), 'w'.repeat(287), 'w'.repeat(331), 'w'.repeat(362),
  'v'.repeat(412), 'v'.repeat(450), 'v'.repeat(504), 'v'.repeat(560), 'v'.repeat(624), 'v'.repeat(666),
];

let ok = 0;
let fail = 0;
samples.forEach((text, i) => {
  let got = '';
  let size = 0;
  try {
    const m = qrMatrix(text);
    size = m.length;
    const file = `${OUT}/qr-${String(i).padStart(2, '0')}.png`;
    writeFileSync(file, png(m));
    got = execFileSync('zbarimg', ['--raw', '-q', '-Sbinary', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
  } catch (e) {
    got = `ERROR ${e.message.split('\n')[0]}`;
  }
  const pass = got === text;
  if (pass) ok++; else fail++;
  console.log(pass ? 'ok  ' : 'FAIL', `#${i} len ${new TextEncoder().encode(text).length} size ${size}`, pass ? '' : `got ${JSON.stringify(got.slice(0, 60))}`);
});
console.log(`${ok}/${samples.length} QR codes decoded exactly`);
process.exit(fail === 0 && ok === samples.length && ok > 0 ? 0 : 1);
