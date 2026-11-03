import qrcode from "qrcode-generator";

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(b: Uint8Array): number {
  let a = 1,
    s = 0;
  for (const x of b) {
    a = (a + x) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array(4 + data.length);
  body.set(t);
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length));
  out.set(body, 4);
  out.set(u32(crc32(body)), 8 + data.length);
  return out;
}

/** zlib stream using stored (uncompressed) deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 65535, (i + 1) * 65535);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = part.length & 255;
    out[o++] = part.length >> 8;
    out[o++] = ~part.length & 255;
    out[o++] = (~part.length >> 8) & 255;
    out.set(part, o);
    o += part.length;
  }
  out.set(u32(adler32(raw)), o);
  return out;
}

export function qrMatrix(text: string): boolean[][] {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

export function qrPng(text: string, scale = 8, quiet = 4): Uint8Array {
  const m = qrMatrix(text);
  const size = (m.length + quiet * 2) * scale;
  const raw = new Uint8Array((size + 1) * size).fill(255);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // filter: none
    const r = Math.floor(y / scale) - quiet;
    if (r < 0 || r >= m.length) continue;
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - quiet;
      if (c >= 0 && c < m.length && m[r][c]) raw[y * (size + 1) + 1 + x] = 0;
    }
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(size), 0);
  ihdr.set(u32(size), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
