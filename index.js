const net = require('net');
const http = require('http');

const CONFIG = {
  host: 'my-mc.link',
  port: 36845,
  protocolVersion: 775, // 26.1.2
  reconnectDelay: 5000,
};

let status = 'connecting';
let reconnectTimer = null;

// VarInt encode
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

// VarInt decode
function readVarInt(buffer, offset) {
  let result = 0, shift = 0, byte;
  do {
    byte = buffer[offset++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, offset };
}

// Write string (UTF-8 with VarInt length prefix)
function writeString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

// Build packet: [length varint][packet_id varint][data]
function buildPacket(packetId, data) {
  const id = writeVarInt(packetId);
  const body = Buffer.concat([id, data]);
  const len = writeVarInt(body.length);
  return Buffer.concat([len, body]);
}

function connect() {
  if (reconnectTimer) return;
  status = 'connecting';
  const username = 'Guard' + Math.floor(Math.random() * 9999);
  console.log(`[Bot] Connecting as ${username} to ${CONFIG.host}:${CONFIG.port}...`);

  const socket = net.createConnection(CONFIG.port, CONFIG.host);
  socket.setTimeout(30000);

  socket.on('connect', () => {
    console.log('[Bot] TCP connected! Sending handshake...');

    // Handshake packet (0x00)
    // Fields: protocol version, server address, port, next state (2=login)
    const handshake = Buffer.concat([
      writeVarInt(CONFIG.protocolVersion),
      writeString(CONFIG.host),
      Buffer.from([0x86, 0x51]), // port 33861... actually port as unsigned short
      writeVarInt(2), // next state: login
    ]);

    // Fix port encoding (big endian unsigned short)
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(CONFIG.port);
    const handshakeFixed = Buffer.concat([
      writeVarInt(CONFIG.protocolVersion),
      writeString(CONFIG.host),
      portBuf,
      writeVarInt(2),
    ]);

    socket.write(buildPacket(0x00, handshakeFixed));

    // Login Start packet (0x00 in login state)
    // Fields: name (string), uuid (optional)
    const uuidBuf = Buffer.alloc(16, 0); // null UUID
    const loginStart = Buffer.concat([
      writeString(username),
      uuidBuf,
    ]);
    socket.write(buildPacket(0x00, loginStart));

    status = 'login';
    console.log('[Bot] Login sent!');
  });

  let recvBuffer = Buffer.alloc(0);

  socket.on('data', (data) => {
    recvBuffer = Buffer.concat([recvBuffer, data]);
    
    try {
      // Try read packet length
      const lenResult = readVarInt(recvBuffer, 0);
      const totalLen = lenResult.value + lenResult.offset;
      
      if (recvBuffer.length < totalLen) return; // wait for more data
      
      const packetData = recvBuffer.slice(lenResult.offset, totalLen);
      recvBuffer = recvBuffer.slice(totalLen);
      
      const pidResult = readVarInt(packetData, 0);
      const pid = pidResult.value;
      
      console.log(`[Bot] Packet received: 0x${pid.toString(16)} (state: ${status})`);

      if (status === 'login') {
        if (pid === 0x02) {
          // Login Success
          status = 'online';
          console.log('[Bot] ✅ Login successful! Bot is online!');
          startKeepAlive(socket);
        } else if (pid === 0x00) {
          // Disconnect
          const msgLen = readVarInt(packetData, pidResult.offset);
          const msg = packetData.slice(msgLen.offset, msgLen.offset + msgLen.value).toString('utf8');
          console.log('[Bot] Disconnect:', msg);
          socket.destroy();
        } else if (pid === 0x03) {
          // Set Compression
          console.log('[Bot] Compression requested (not supported, reconnecting)');
          socket.destroy();
        }
      } else if (status === 'online') {
        if (pid === 0x26 || pid === 0x24 || pid === 0x23) {
          // Keep Alive - respond immediately
          const keepAliveId = packetData.slice(pidResult.offset, pidResult.offset + 8);
          socket.write(buildPacket(0x18, keepAliveId));
          console.log('[Bot] Keep-alive sent');
        }
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  socket.on('timeout', () => {
    console.log('[Bot] Timeout!');
    socket.destroy();
  });

  socket.on('error', (err) => {
    status = 'error';
    console.log('[Bot] Error:', err.message);
  });

  socket.on('close', () => {
    status = 'disconnected';
    console.log('[Bot] Disconnected! Reconnecting in 5s...');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, CONFIG.reconnectDelay);
  });
}

function startKeepAlive(socket) {
  // Send chat packet mỗi 60s để không bị AFK kick
  const interval = setInterval(() => {
    if (socket.destroyed) { clearInterval(interval); return; }
    try {
      // Swing arm packet để giả vờ active
      socket.write(buildPacket(0x36, Buffer.from([0x00])));
    } catch (e) {}
  }, 55000);
}

// HTTP server giữ Render không sleep
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status, host: CONFIG.host, port: CONFIG.port, protocol: CONFIG.protocolVersion }));
}).listen(process.env.PORT || 3000, () => {
  console.log('[HTTP] Running on port', process.env.PORT || 3000);
});

connect();

process.on('uncaughtException', (err) => console.log('[Error]', err.message));
process.on('unhandledRejection', (err) => console.log('[Rejection]', err));
