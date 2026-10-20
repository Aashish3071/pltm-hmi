/**
 * Renders resources/icon.png and a multi-size resources/icon.ico (the Windows
 * app/installer icon). To use real Novatek artwork, replace the SVG below — or
 * set ICON_SOURCE=/path/to/logo.png — and rerun: npm run icon
 */
import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3b6fd4"/>
      <stop offset="100%" stop-color="#1b3a86"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <!-- contact strip (overhead wire contact) -->
  <rect x="118" y="104" width="276" height="26" rx="13" fill="#ffffff"/>
  <rect x="150" y="130" width="30" height="26" fill="#ffffff"/>
  <rect x="332" y="130" width="30" height="26" fill="#ffffff"/>
  <!-- pantograph arms -->
  <path d="M256 156 L150 300" stroke="#ff5a5a" stroke-width="30" stroke-linecap="round" fill="none"/>
  <path d="M256 156 L362 300" stroke="#ff5a5a" stroke-width="30" stroke-linecap="round" fill="none"/>
  <path d="M150 300 L216 392" stroke="#ff5a5a" stroke-width="30" stroke-linecap="round" fill="none"/>
  <path d="M362 300 L296 392" stroke="#ff5a5a" stroke-width="30" stroke-linecap="round" fill="none"/>
  <!-- base -->
  <rect x="112" y="392" width="288" height="34" rx="17" fill="#ffffff"/>
</svg>`

app.disableHardwareAcceleration()

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** Packs PNG frames into an .ico (PNG-in-ICO is supported since Windows Vista). */
function buildIco(source: NativeImage): Buffer {
  const frames = ICO_SIZES.map((size) => ({
    size,
    png: source.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  const directory = Buffer.alloc(16 * frames.length)
  let offset = header.length + directory.length
  frames.forEach((frame, i) => {
    const entry = i * 16
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, entry)
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, entry + 1)
    directory.writeUInt8(0, entry + 2)
    directory.writeUInt8(0, entry + 3)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(frame.png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += frame.png.length
  })
  return Buffer.concat([header, directory, ...frames.map((f) => f.png)])
}

async function renderSvg(): Promise<NativeImage> {
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })

  await window.loadURL(
    `data:text/html,${encodeURIComponent(
      `<html><body style="margin:0;background:transparent">${SVG}</body></html>`
    )}`
  )
  await new Promise((resolve) => setTimeout(resolve, 400))

  return window.webContents.capturePage()
}

app.whenReady().then(async () => {
  const image = process.env.ICON_SOURCE
    ? nativeImage.createFromBuffer(readFileSync(process.env.ICON_SOURCE))
    : await renderSvg()
  const dir = join(__dirname, '..', '..', 'resources')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'icon.png'), image.toPNG())
  writeFileSync(join(dir, 'icon.ico'), buildIco(image))
  console.log(`wrote resources/icon.png (${image.getSize().width}x${image.getSize().height}) and icon.ico (${ICO_SIZES.join(', ')} px)`)
  app.exit(0)
})
