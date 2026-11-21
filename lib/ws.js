import { createHash } from 'node:crypto'

// RFC 6455 bits we actually need: one text/binary frame stream per socket.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** The Sec-WebSocket-Accept value for one client key. */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** One unmasked server-to-client frame. */
export function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

/**
 * Incremental parser for masked client frames. Calls back with
 * `{ kind: 'text' | 'binary', payload }`, `{ kind: 'ping' }`, `{ kind: 'pong' }`,
 * or `{ kind: 'close' }`; fragmented messages are reassembled first.
 */
export function createFrameParser(onFrame) {
  let buffer = Buffer.alloc(0)
  let fragments = []
  let fragmentOpcode = 0

  return function push(chunk) {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2

      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (length > MAX_FRAME_BYTES) {
        onFrame({ kind: 'close', code: 1009, reason: 'frame too large' })
        buffer = Buffer.alloc(0)
        return
      }

      const maskOffset = offset
      if (masked) offset += 4
      if (buffer.length < offset + length) return

      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= buffer[maskOffset + (index % 4)]
        }
      }
      buffer = buffer.subarray(offset + length)

      if (opcode === OPCODE.PING) { onFrame({ kind: 'ping', payload }); continue }
      if (opcode === OPCODE.PONG) { onFrame({ kind: 'pong', payload }); continue }
      if (opcode === OPCODE.CLOSE) { onFrame({ kind: 'close', payload }); return }
      if (opcode === OPCODE.CONTINUATION) {
        fragments.push(payload)
        if (!fin) continue
        const joined = Buffer.concat(fragments)
        fragments = []
        onFrame({ kind: fragmentOpcode === OPCODE.BINARY ? 'binary' : 'text', payload: joined })
        continue
      }
      if (!fin) {
        fragments = [payload]
        fragmentOpcode = opcode
        continue
      }
      onFrame({ kind: opcode === OPCODE.BINARY ? 'binary' : 'text', payload })
    }
  }
}

/**
 * One live WebSocket peer. The transport owns the socket from here on: it
 * answers ping frames, parses text messages as JSON, and serializes sends.
 */
export function createConnection(socket) {
  const listeners = new Set()
  let closed = false

  const connection = {
    get closed() { return closed },
    send(value) {
      if (closed || !socket.writable) return false
      socket.write(encodeFrame(OPCODE.TEXT, JSON.stringify(value)))
      return true
    },
    ping() {
      if (closed || !socket.writable) return
      socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)))
    },
    close(code = 1000, reason = '') {
      if (closed) return
      closed = true
      const body = Buffer.alloc(2 + Buffer.byteLength(reason))
      body.writeUInt16BE(code, 0)
      body.write(reason, 2)
      try {
        socket.write(encodeFrame(OPCODE.CLOSE, body))
        socket.end()
      } catch {
        socket.destroy()
      }
      for (const listener of listeners) listener({ kind: 'close' })
      listeners.clear()
    },
    /** Register a message/close listener; returns its disposer. */
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  const parse = createFrameParser((frame) => {
    if (frame.kind === 'ping') {
      if (!closed && socket.writable) socket.write(encodeFrame(OPCODE.PONG, frame.payload ?? Buffer.alloc(0)))
      return
    }
    if (frame.kind === 'pong') return
    if (frame.kind === 'close') { connection.close(1000, 'bye'); return }
    if (frame.kind !== 'text') return
    let value
    try {
      value = JSON.parse(frame.payload.toString('utf8'))
    } catch {
      return
    }
    for (const listener of listeners) listener({ kind: 'message', value })
  })

  socket.on('data', (chunk) => {
    try {
      parse(chunk)
    } catch {
      connection.close(1011, 'parse error')
    }
  })
  socket.on('error', () => connection.close(1011, 'socket error'))
  socket.on('close', () => connection.close(1001, 'socket closed'))

  return connection
}

/**
 * Complete the HTTP upgrade: validate the handshake, answer 101, and return the
 * live connection. Returns `undefined` when the request is not a valid upgrade
 * (the caller then destroys the socket).
 */
export function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  const connectionHeader = String(req.headers.connection ?? '').toLowerCase()
  if (typeof key !== 'string' || version !== '13' || !connectionHeader.includes('upgrade')) return undefined

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`
    + '\r\n',
  )
  const connection = createConnection(socket)
  if (head?.length > 0) socket.emit('data', head)
  return connection
}
