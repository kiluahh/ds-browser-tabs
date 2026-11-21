// 从同一个 extension/ 生成 Firefox 版（event page + gecko id）并打包成 .xpi。
//
//   node scripts/build-firefox.mjs
//
// 产物：
//   dist/firefox/                       —— about:debugging 里"临时载入"选它的 manifest.json
//   dist/ds-browser-tabs-firefox.xpi    —— 开发者版/夜间版可"从文件安装"
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = join(root, 'extension')
const dist = join(root, 'dist')
const firefoxDir = join(dist, 'firefox')

/** Firefox MV3 uses an event page, not a service worker, and needs a gecko id. */
function firefoxManifest(base) {
  return {
    manifest_version: 3,
    name: base.name,
    version: base.version,
    description: base.description,
    permissions: base.permissions,
    // Firefox matches WebSocket hosts against `ws://` patterns; Chrome does not
    // accept that scheme, so the ws entries live only in the Firefox build.
    host_permissions: [...base.host_permissions, 'ws://127.0.0.1/*', 'ws://localhost/*'],
    content_security_policy: base.content_security_policy,
    background: { scripts: ['background.js'], type: 'module' },
    action: base.action,
    icons: base.icons,
    browser_specific_settings: {
      gecko: {
        id: 'ds-browser-tabs@local',
        strict_min_version: '112.0',
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (deflate, UTF-8 names). Enough for an unsigned .xpi.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const body = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...centrals, end])
}

// ---------------------------------------------------------------------------

const base = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
await rm(dist, { recursive: true, force: true })
await mkdir(firefoxDir, { recursive: true })

const files = (await readdir(source)).filter((name) => name !== 'manifest.json')
const entries = []
for (const name of files) {
  const data = await readFile(join(source, name))
  entries.push([name, data])
  await writeFile(join(firefoxDir, name), data)
}

const manifestText = `${JSON.stringify(firefoxManifest(base), null, 2)}\n`
await writeFile(join(firefoxDir, 'manifest.json'), manifestText)
entries.push(['manifest.json', Buffer.from(manifestText, 'utf8')])

const xpi = zip(entries)
await writeFile(join(dist, 'ds-browser-tabs-firefox.xpi'), xpi)

console.log(`firefox build: ${firefoxDir}`)
console.log(`xpi: ${join(dist, 'ds-browser-tabs-firefox.xpi')} (${xpi.length} bytes, ${entries.length} files)`)
