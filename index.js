const net = require('net');
const http = require('http');
const zlib = require('zlib');

const CONFIG = {
  host: 'my-mc.link',
  port: 36845,
  protocolVersion: 775,
  reconnectDelay: 5000,
};

let status = 'connecting';
let reconnectTimer = null;

function writeVarInt(value) {
  const bytes = [];
  do {
    let temp = value & 0x7F;
    value >>>= 7;
    if (value !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset) {
  let result = 0, shift = 0, byte, read = 0;
  do {
    if (offset >= buffer.length) throw new Error('Buffer too short');
    byte = buffer[offset++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
    read++;
  } while (byte & 0x80);
  return { value: result, offset, bytes: read };
}

function writeString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

function buildPacket(packetId, data, compressionThreshold = -1) {
  const id = writeVarInt(packetId);
  const body = Buffer.concat([id, data]);

  if (compressionThreshold < 0) {
    // No compression
    return Buffer.concat([writeVarInt(body.length), body]);
  } else {
    if (body.length >= compressionThreshold) {
      // Compress
      const compressed = zlib.deflateSync(body);
      const dataLength = writeVarInt(body.length);
      const inner = Buffer.concat([dataLength, compressed]);
      return Buffer.concat([writeVarInt(inner.length), inner]);
    } else {
      // Under threshold, no compress
      const dataLength = writeVarInt(0); // 0 = uncompressed
      const inner = Buffer.concat([dataLength, body]);
      return Buffer.concat([writeVarInt(inner.length), inner]);
    }
  }
}

function connect() {
  if (reconnectTimer) return;
  status = 'connecting';
  const username = 'Guard' + Math.floor(Math.random() * 9999);
  console.log(`[Bot] Connecting as ${username}...`);

  let compressionThreshold = -1;
  let recvBuffer = Buffer.alloc(0);

  const socket = net.createConnection(CONFIG.port, CONFIG.host);
  socket.setTimeout(30000);

  socket.on('connect', () => {
    console.log('[Bot] Connected! Sending handshake...');

    // Handshake
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(CONFIG.port);
    const handshake = Buffer.concat([
      writeVarInt(CONFIG.protocolVersion),
      writeString(CONFIG.host),
      portBuf,
      writeVarInt(2),
    ]);
    socket.write(buildPacket(0x00, handshake));

    // Login Start
    const uuidBuf = Buffer.alloc(16, 0);
    const loginStart = Buffer.concat([writeString(username), uuidBuf]);
    socket.write(buildPacket(0x00, loginStart));

    status = 'login';
    console.log('[Bot] Login sent!');
  });

  socket.on('data', (data) => {
    recvBuffer = Buffer.concat([recvBuffer, data]);

    while (recvBuffer.length > 0) {
      try {
        const lenResult = readVarInt(recvBuffer, 0);
        const totalLen = lenResult.value + lenResult.bytes;
        if (recvBuffer.length < totalLen) break;

        let packetData = recvBuffer.slice(lenResult.bytes, totalLen);
        recvBuffer = recvBuffer.slice(totalLen);

        // Handle compression
        if (compressionThreshold >= 0) {
          const dataLen = readVarInt(packetData, 0);
          if (dataLen.value === 0) {
            packetData = packetData.slice(dataLen.bytes);
          } else {
            const compressed = packetData.slice(dataLen.bytes);
            packetData = zlib.inflateSync(compressed);
          }
        }

        const pidResult = readVarInt(packetData, 0);
        const pid = pidResult.value;
        const payload = packetData.slice(pidResult.bytes);

        if (status === 'login') {
          if (pid === 0x03) {
            // Set Compression
            const threshold = readVarInt(payload, 0);
            compressionThreshold = threshold.value;
            console.log(`[Bot] Compression enabled! Threshold: ${compressionThreshold}`);
          } else if (pid === 0x02) {
            // Login Success
            status = 'online';
            console.log('[Bot] ✅ Logged in! Bot is ONLINE!');
            startKeepAlive(socket, compressionThreshold);
          } else if (pid === 0x00) {
            const msgLen = readVarInt(payload, 0);
            const msg = payload.slice(msgLen.bytes, msgLen.bytes + msgLen.value).toString('utf8');
            console.log('[Bot] Kicked:', msg);
            socket.destroy();
          }
        } else if (status === 'online') {
          // Keep Alive packets (varies by version)
          if (pid === 0x26 || pid === 0x24 || pid === 0x1F || pid === 0x21) {
            socket.write(buildPacket(0x18, payload, compressionThreshold));
            console.log('[Bot] Keep-alive ✓');
          }
        }
      } catch (e) {
        break;
      }
    }
  });

  socket.on('timeout', () => { console.log('[Bot] Timeout!'); socket.destroy(); });
  socket.on('error', (err) => { status = 'error'; console.log('[Bot] Error:', err.message); });
  socket.on('close', () => {
    status = 'disconnected';
    console.log('[Bot] Disconnected! Reconnect in 5s...');
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, CONFIG.reconnectDelay);
  });
}

function startKeepAlive(socket, compressionThreshold) {
  const interval = setInterval(() => {
    if (socket.destroyed) { clearInterval(interval); return; }
    try {
      // Swing arm
      socket.write(buildPacket(0x36, Buffer.from([0x00]), compressionThreshold));
    } catch (e) { clearInterval(interval); }
  }, 50000);
}

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status, host: CONFIG.host, port: CONFIG.port }));
}).listen(process.env.PORT || 3000, () => {
  console.log('[HTTP] Running on port', process.env.PORT || 3000);
});

connect();
process.on('uncaughtException', (err) => console.log('[Error]', err.message));
process.on('unhandledRejection', (err) => console.log('[Rejection]', err));
