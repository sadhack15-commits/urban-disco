const net = require('net');
const http = require('http');
const zlib = require('zlib');

const CONFIG = {
  host: 'my-mc.link',
  port: 36845,
  protocolVersion: 775,
  reconnectDelay: 5000,
};

let botState = {
  status: 'connecting',
  username: '',
  x: 0, y: 0, z: 0,
  health: 20,
  food: 20,
  online: false,
  startTime: Date.now(),
  reconnects: 0,
  lastSeen: null,
  viewBuffer: [], // last 50 chat/events
};

function log(msg) {
  const time = new Date().toISOString().slice(11,19);
  const line = `[${time}] ${msg}`;
  console.log(line);
  botState.viewBuffer.push(line);
  if (botState.viewBuffer.length > 50) botState.viewBuffer.shift();
}

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
    return Buffer.concat([writeVarInt(body.length), body]);
  } else {
    if (body.length >= compressionThreshold) {
      const compressed = zlib.deflateSync(body);
      const inner = Buffer.concat([writeVarInt(body.length), compressed]);
      return Buffer.concat([writeVarInt(inner.length), inner]);
    } else {
      const inner = Buffer.concat([writeVarInt(0), body]);
      return Buffer.concat([writeVarInt(inner.length), inner]);
    }
  }
}

let reconnectTimer = null;

function connect() {
  if (reconnectTimer) return;
  botState.username = 'Guard' + Math.floor(Math.random() * 9999);
  botState.status = 'connecting';
  botState.online = false;
  log(`Connecting as ${botState.username}...`);

  let compressionThreshold = -1;
  let recvBuffer = Buffer.alloc(0);

  const socket = net.createConnection(CONFIG.port, CONFIG.host);
  socket.setTimeout(30000);

  socket.on('connect', () => {
    log('TCP connected! Sending handshake...');
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(CONFIG.port);
    const handshake = Buffer.concat([
      writeVarInt(CONFIG.protocolVersion),
      writeString(CONFIG.host),
      portBuf,
      writeVarInt(2),
    ]);
    socket.write(buildPacket(0x00, handshake));
    const uuidBuf = Buffer.alloc(16, 0);
    socket.write(buildPacket(0x00, Buffer.concat([writeString(botState.username), uuidBuf])));
    botState.status = 'login';
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

        if (compressionThreshold >= 0) {
          const dataLen = readVarInt(packetData, 0);
          if (dataLen.value === 0) {
            packetData = packetData.slice(dataLen.bytes);
          } else {
            packetData = zlib.inflateSync(packetData.slice(dataLen.bytes));
          }
        }

        const pidResult = readVarInt(packetData, 0);
        const pid = pidResult.value;
        const payload = packetData.slice(pidResult.bytes);

        if (botState.status === 'login') {
          if (pid === 0x03) {
            const threshold = readVarInt(payload, 0);
            compressionThreshold = threshold.value;
            log(`Compression enabled: ${compressionThreshold}`);
          } else if (pid === 0x02) {
            botState.status = 'online';
            botState.online = true;
            botState.lastSeen = Date.now();
            log('✅ Bot ONLINE!');
            startKeepAlive(socket, compressionThreshold);
          } else if (pid === 0x00) {
            try {
              const msgLen = readVarInt(payload, 0);
              const msg = payload.slice(msgLen.bytes, msgLen.bytes + msgLen.value).toString('utf8');
              log(`Kicked: ${msg}`);
            } catch(e) {}
            socket.destroy();
          }
        } else if (botState.status === 'online') {
          botState.lastSeen = Date.now();

          // Keep Alive
          if (pid === 0x26 || pid === 0x24 || pid === 0x1F || pid === 0x21 || pid === 0x27) {
            socket.write(buildPacket(0x18, payload, compressionThreshold));
            log('Keep-alive ✓');
          }

          // Player Position (server → client): update XYZ
          if (pid === 0x40 || pid === 0x3E || pid === 0x3C) {
            try {
              let off = 0;
              botState.x = payload.readDoubleBE(off); off += 8;
              botState.y = payload.readDoubleBE(off); off += 8;
              botState.z = payload.readDoubleBE(off); off += 8;
              log(`Position: ${Math.floor(botState.x)}, ${Math.floor(botState.y)}, ${Math.floor(botState.z)}`);
            } catch(e) {}
          }

          // Health Update
          if (pid === 0x24 || pid === 0x1A || pid === 0x1B) {
            try {
              botState.health = payload.readFloatBE(0);
              botState.food = readVarInt(payload, 4).value;
            } catch(e) {}
          }

          // Death → respawn
          if (pid === 0x23 || pid === 0x1E) {
            log('💀 Died! Respawning...');
            setTimeout(() => {
              try { socket.write(buildPacket(0x09, Buffer.from([0x00]), compressionThreshold)); } catch(e) {}
            }, 1000);
          }
        }
      } catch (e) { break; }
    }
  });

  socket.on('timeout', () => { log('Timeout!'); socket.destroy(); });
  socket.on('error', (err) => { botState.status = 'error'; log(`Error: ${err.message}`); });
  socket.on('close', () => {
    botState.status = 'disconnected';
    botState.online = false;
    botState.reconnects++;
    log(`Disconnected! Reconnect #${botState.reconnects} in 5s...`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, CONFIG.reconnectDelay);
  });
}

function startKeepAlive(socket, compressionThreshold) {
  const interval = setInterval(() => {
    if (socket.destroyed) { clearInterval(interval); return; }
    try {
      socket.write(buildPacket(0x36, Buffer.from([0x00]), compressionThreshold));
    } catch (e) { clearInterval(interval); }
  }, 50000);
}

// HTTP server + Dashboard
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="5">
<title>MC Bot Dashboard</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0a0a; color:#00ff88; font-family:'Courier New',monospace; padding:20px; }
  h1 { color:#00ffff; text-align:center; margin-bottom:20px; font-size:24px; text-shadow:0 0 10px #00ffff; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:15px; margin-bottom:20px; }
  .card { background:#111; border:1px solid #00ff8844; border-radius:8px; padding:15px; }
  .card h3 { color:#888; font-size:12px; margin-bottom:8px; text-transform:uppercase; }
  .card .val { font-size:22px; font-weight:bold; }
  .online { color:#00ff88; }
  .offline { color:#ff4444; }
  .connecting { color:#ffaa00; }
  .pos { color:#00ffff; font-size:16px; }
  .log { background:#111; border:1px solid #00ff8844; border-radius:8px; padding:15px; height:300px; overflow-y:auto; }
  .log h3 { color:#888; font-size:12px; margin-bottom:10px; text-transform:uppercase; }
  .log-line { font-size:12px; color:#aaa; margin-bottom:4px; border-bottom:1px solid #1a1a1a; padding-bottom:4px; }
  .bar { background:#222; border-radius:4px; height:8px; margin-top:5px; }
  .bar-fill { height:8px; border-radius:4px; transition:width 0.3s; }
  .health-bar { background:#ff4444; }
  .food-bar { background:#ffaa00; }
  .ping { color:#00ffff; font-size:11px; margin-top:5px; }
</style>
</head>
<body>
<h1>🤖 MC Guard Bot Dashboard</h1>
<div class="grid">
  <div class="card">
    <h3>Status</h3>
    <div class="val STATUS_CLASS">STATUS_TEXT</div>
    <div class="ping">Auto-refresh: 5s</div>
  </div>
  <div class="card">
    <h3>Username</h3>
    <div class="val" style="color:#ffff00">USERNAME</div>
  </div>
  <div class="card">
    <h3>Position</h3>
    <div class="val pos">X: POS_X</div>
    <div class="val pos">Y: POS_Y</div>
    <div class="val pos">Z: POS_Z</div>
  </div>
  <div class="card">
    <h3>Health ❤️</h3>
    <div class="val" style="color:#ff4444">HEALTH / 20</div>
    <div class="bar"><div class="bar-fill health-bar" style="width:HEALTH_PCT%"></div></div>
  </div>
  <div class="card">
    <h3>Food 🍖</h3>
    <div class="val" style="color:#ffaa00">FOOD / 20</div>
    <div class="bar"><div class="bar-fill food-bar" style="width:FOOD_PCT%"></div></div>
  </div>
  <div class="card">
    <h3>Uptime</h3>
    <div class="val" style="color:#aa88ff">UPTIME</div>
    <div class="ping">Reconnects: RECONNECTS</div>
  </div>
</div>
<div class="log">
  <h3>📋 Event Log</h3>
  LOG_LINES
</div>
</body>
</html>`;

function formatUptime(ms) {
  const s = Math.floor(ms/1000);
  const m = Math.floor(s/60);
  const h = Math.floor(m/60);
  return `${h}h ${m%60}m ${s%60}s`;
}

http.createServer((req, res) => {
  if (req.url === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(botState));
    return;
  }

  const statusClass = botState.online ? 'online' : botState.status === 'connecting' ? 'connecting' : 'offline';
  const statusText = botState.online ? '🟢 ONLINE' : botState.status === 'connecting' ? '🟡 CONNECTING' : '🔴 OFFLINE';
  const healthPct = Math.max(0, Math.min(100, (botState.health / 20) * 100)).toFixed(0);
  const foodPct = Math.max(0, Math.min(100, (botState.food / 20) * 100)).toFixed(0);
  const logLines = [...botState.viewBuffer].reverse().map(l => `<div class="log-line">${l}</div>`).join('');

  const html = DASHBOARD_HTML
    .replace('STATUS_CLASS', statusClass)
    .replace('STATUS_TEXT', statusText)
    .replace('USERNAME', botState.username)
    .replace('POS_X', Math.floor(botState.x))
    .replace('POS_Y', Math.floor(botState.y))
    .replace('POS_Z', Math.floor(botState.z))
    .replace('HEALTH', botState.health.toFixed(1))
    .replace('HEALTH_PCT', healthPct)
    .replace('FOOD', botState.food)
    .replace('FOOD_PCT', foodPct)
    .replace('UPTIME', formatUptime(Date.now() - botState.startTime))
    .replace('RECONNECTS', botState.reconnects)
    .replace('LOG_LINES', logLines);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}).listen(process.env.PORT || 3000, () => {
  log(`HTTP Dashboard running on port ${process.env.PORT || 3000}`);
});

connect();
process.on('uncaughtException', (err) => log(`[Error] ${err.message}`));
process.on('unhandledRejection', (err) => log(`[Rejection] ${err}`));
