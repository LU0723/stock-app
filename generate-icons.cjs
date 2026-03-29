/**
 * 產生 PWA placeholder icon（純 Node.js built-in，不需要額外安裝套件）
 *
 * 執行方式：node generate-icons.js
 *
 * 之後要換成正式 icon：
 *   直接替換 public/pwa-192x192.png 和 public/pwa-512x512.png
 *   替換後重新 build 即可，這支 script 不需要再跑。
 */

const fs   = require('fs')
const zlib = require('zlib')

// ─── CRC32 ────────────────────────────────────────────────────────────────────

const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  crcTable[i] = c
}
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ─── PNG chunk builder ────────────────────────────────────────────────────────

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crcBuf])
}

// ─── Icon generator ───────────────────────────────────────────────────────────

function makeIcon(size) {
  const stride = 1 + size * 3  // 1 filter byte + 3 bytes (RGB) per pixel
  const raw    = Buffer.alloc(size * stride)

  // 填背景色 #1a1a1a
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0  // filter = none
    for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 3
      raw[i] = 0x1a; raw[i+1] = 0x1a; raw[i+2] = 0x1a
    }
  }

  // 繪製 4 根 K 棒（台股風格：紅漲綠跌）
  const bars = [
    { xPct: 0.12, hPct: 0.42, r: 239, g: 68,  b: 68  },  // 紅（漲）
    { xPct: 0.32, hPct: 0.62, r: 239, g: 68,  b: 68  },  // 紅（漲）
    { xPct: 0.52, hPct: 0.28, r: 52,  g: 211, b: 153 },  // 綠（跌）
    { xPct: 0.72, hPct: 0.50, r: 239, g: 68,  b: 68  },  // 紅（漲）
  ]
  const barW  = Math.max(2, Math.floor(size * 0.13))
  const floor = Math.floor(size * 0.82)

  for (const bar of bars) {
    const x0   = Math.floor(size * bar.xPct)
    const barH = Math.floor(size * bar.hPct)
    const y0   = floor - barH
    for (let y = y0; y < floor; y++) {
      for (let x = x0; x < Math.min(x0 + barW, size); x++) {
        const i = y * stride + 1 + x * 3
        raw[i] = bar.r; raw[i+1] = bar.g; raw[i+2] = bar.b
      }
    }
  }

  // 組合 PNG bytes
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // color type: RGB

  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ─── 輸出檔案 ─────────────────────────────────────────────────────────────────

fs.mkdirSync('public', { recursive: true })
fs.writeFileSync('public/pwa-192x192.png', makeIcon(192))
fs.writeFileSync('public/pwa-512x512.png', makeIcon(512))
console.log('✓ 產生 public/pwa-192x192.png')
console.log('✓ 產生 public/pwa-512x512.png')
console.log('  之後要換正式 icon，直接替換這兩個檔案即可。')
