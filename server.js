const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Docker = require('dockerode');
const { PassThrough } = require('stream');
const path = require('path');
const fs = require('fs');
const si = require('systeminformation');

// ── DOCKER ──
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ── CONFIG ──
const configPath = path.join(__dirname, 'config.json');
const eggsPath  = path.join(__dirname, 'eggs');

function loadConfig() { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
function saveConfig(cfg) { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2)); }
let config = loadConfig();

// ── EGGS ──
function loadEggs() {
  if (!fs.existsSync(eggsPath)) return [];
  return fs.readdirSync(eggsPath)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const egg = JSON.parse(fs.readFileSync(path.join(eggsPath, f), 'utf8'));
        egg._id = f.replace('.json', '');
        return egg;
      } catch { return null; }
    })
    .filter(Boolean);
}

// ── STATE ──
// id → { status, logs, startedAt, stdinStream, cfg }
const processes = {};
const activityLog = [];

function initServer(cfg) {
  if (!processes[cfg.id]) {
    processes[cfg.id] = { status: 'offline', logs: [], startedAt: null, stdinStream: null, containerStats: null, cfg };
  } else {
    processes[cfg.id].cfg = cfg;
  }
}

function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*[mGKHF]/g, '').replace(/\r/g, '');
}

function pushLog(id, line, type = 'info') {
  const entry = { ts: new Date().toLocaleTimeString('en-GB', { hour12: false }), line: stripAnsi(line), type };
  if (!processes[id]) return;
  processes[id].logs.push(entry);
  if (processes[id].logs.length > 2000) processes[id].logs.shift();
  broadcast({ event: 'log', id, entry });
}

function pushActivity(message, color = 'blue') {
  const entry = { message, color, time: Date.now() };
  activityLog.unshift(entry);
  if (activityLog.length > 100) activityLog.pop();
  broadcast({ event: 'activity', entry });
}

// ── DOCKER HELPERS ──

async function ensureImageExists(id, image) {
  try {
    await docker.getImage(image).inspect();
    return; // already exists
  } catch {}
  // Pull
  pushLog(id, `Pulling image: ${image} ...`, 'info');
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(err);
        pushLog(id, `Image pulled: ${image}`, 'ok');
        resolve();
      }, (event) => {
        const s = event.status;
        if (['Pull complete', 'Already exists', 'Downloading', 'Extracting'].includes(s)) {
          pushLog(id, `  ${s} ${event.id || ''}`.trim(), 'info');
        }
      });
    });
  });
}

function buildStartupCmd(cfg) {
  let cmd = cfg.startup || '';
  Object.entries(cfg.env || {}).forEach(([k, v]) => {
    cmd = cmd.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
  });
  return cmd.trim();
}

function parsePortBindings(ports) {
  const portBindings = {};
  const exposedPorts = {};
  (ports || []).forEach(p => {
    const parts = p.split(':');
    if (parts.length < 2) return;
    const hostPort = parts[0];
    const rest = parts[1];
    const [cPort, proto = 'tcp'] = rest.split('/');
    portBindings[`${cPort}/${proto}`] = [{ HostPort: String(hostPort) }];
    exposedPorts[`${cPort}/${proto}`] = {};
  });
  return { portBindings, exposedPorts };
}

async function getContainer(cfg) {
  const name = `hsm-${cfg.id}`;

  // Try by stored ID
  if (cfg.containerId) {
    try {
      const c = docker.getContainer(cfg.containerId);
      await c.inspect();
      return c;
    } catch { cfg.containerId = null; }
  }

  // Try by name
  try {
    const c = docker.getContainer(name);
    const info = await c.inspect();
    cfg.containerId = info.Id;
    return c;
  } catch {}

  return null;
}

async function createContainer(id, cfg) {
  const name = `hsm-${cfg.id}`;
  await ensureImageExists(id, cfg.image);

  const startup = buildStartupCmd(cfg);
  const env = Object.entries(cfg.env || {}).map(([k, v]) => `${k}=${v}`);
  const { portBindings, exposedPorts } = parsePortBindings(cfg.ports);

  pushLog(id, `Creating container: ${name}`, 'info');

  const opts = {
    name,
    Image: cfg.image,
    Env: env,
    ExposedPorts: exposedPorts,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    Tty: false,
    HostConfig: {
      PortBindings: portBindings,
      Binds: cfg.volumes || [],
      Memory: cfg.memory ? cfg.memory * 1024 * 1024 : 0,
      RestartPolicy: { Name: 'no' },
    },
  };

  if (startup) opts.Cmd = ['/bin/sh', '-c', startup];

  const container = await docker.createContainer(opts);
  cfg.containerId = container.id;
  saveConfig(config);
  return container;
}

function attachLogStream(id, container) {
  container.logs({ follow: true, stdout: true, stderr: true, tail: 200 }, (err, stream) => {
    if (err) { pushLog(id, `Log error: ${err.message}`, 'err'); return; }

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(stream, stdout, stderr);

    const onLine = (type) => (chunk) => {
      chunk.toString().split('\n').filter(l => l.trim()).forEach(l => pushLog(id, l, type));
    };
    stdout.on('data', onLine('info'));
    stderr.on('data', onLine('warn'));

    stream.on('end', () => {
      const state = processes[id];
      if (!state || state.status === 'offline') return;
      state.status = 'offline';
      state.stdinStream = null;
      broadcast({ event: 'status', id, status: 'offline' });
      pushLog(id, 'Container stopped.', 'info');
      pushActivity(`${state.cfg.name} stopped`, 'red');

      if (state.cfg.autoRestart) {
        state.restartCount = (state.restartCount || 0) + 1;
        pushLog(id, `Auto-restarting in 5s (attempt ${state.restartCount})...`, 'warn');
        setTimeout(() => startServer(id), 5000);
      }
    });
  });
}

async function attachStdin(id, container) {
  try {
    const stream = await container.attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true });
    processes[id].stdinStream = stream;
  } catch (err) {
    pushLog(id, `Stdin attach warning: ${err.message}`, 'warn');
  }
}

// ── SERVER LIFECYCLE ──

async function startServer(id) {
  const state = processes[id];
  if (!state) return { ok: false, error: 'Unknown server' };
  if (state.status === 'online' || state.status === 'starting') return { ok: false, error: 'Already running' };

  const cfg = state.cfg;
  state.status = 'starting';
  broadcast({ event: 'status', id, status: 'starting' });
  pushLog(id, `Starting ${cfg.name}...`, 'info');

  try {
    let container = await getContainer(cfg);

    if (!container) {
      container = await createContainer(id, cfg);
    } else {
      const info = await container.inspect();
      if (info.State.Running) {
        state.status = 'online';
        state.startedAt = Date.now();
        broadcast({ event: 'status', id, status: 'online' });
        attachLogStream(id, container);
        await attachStdin(id, container);
        return { ok: true };
      }
    }

    await container.start();
    state.status = 'online';
    state.startedAt = Date.now();
    broadcast({ event: 'status', id, status: 'online' });
    pushLog(id, `${cfg.name} started`, 'ok');
    pushActivity(`${cfg.name} started`, 'green');

    attachLogStream(id, container);
    await attachStdin(id, container);
    return { ok: true };
  } catch (err) {
    state.status = 'offline';
    broadcast({ event: 'status', id, status: 'offline' });
    pushLog(id, `Failed to start: ${err.message}`, 'err');
    pushActivity(`${cfg.name} failed to start`, 'red');
    return { ok: false, error: err.message };
  }
}

async function stopServer(id) {
  const state = processes[id];
  if (!state) return { ok: false, error: 'Unknown server' };

  pushLog(id, 'Stopping...', 'warn');
  pushActivity(`${state.cfg.name} stopping`, 'yellow');

  try {
    // Graceful stop command via stdin
    if (state.stdinStream && state.cfg.stopCommand) {
      try { state.stdinStream.write(state.cfg.stopCommand + '\n'); } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }

    const container = await getContainer(state.cfg);
    if (container) await container.stop({ t: 10 }).catch(() => {});

    state.status = 'offline';
    state.stdinStream = null;
    broadcast({ event: 'status', id, status: 'offline' });
    pushActivity(`${state.cfg.name} stopped`, 'blue');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function restartServer(id) {
  const state = processes[id];
  if (!state) return { ok: false, error: 'Unknown server' };

  pushActivity(`${state.cfg.name} restarting`, 'yellow');

  try {
    const container = await getContainer(state.cfg);
    if (container) {
      await container.restart({ t: 10 });
      state.status = 'online';
      state.startedAt = Date.now();
      broadcast({ event: 'status', id, status: 'online' });
      attachLogStream(id, container);
      await attachStdin(id, container);
      pushActivity(`${state.cfg.name} restarted`, 'green');
    } else {
      await startServer(id);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function sendCommand(id, cmd) {
  const state = processes[id];
  if (!state || state.status !== 'online') return { ok: false, error: 'Not running' };
  if (!state.stdinStream) return { ok: false, error: 'No stdin available for this container' };
  try {
    pushLog(id, `> ${cmd}`, 'cmd');
    state.stdinStream.write(cmd + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function deleteServer(id) {
  const state = processes[id];
  if (!state) return { ok: false, error: 'Unknown server' };

  if (state.status === 'online') {
    await stopServer(id).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
  }

  const cfg = state.cfg;
  try {
    const container = await getContainer(cfg);
    if (container) await container.remove({ force: true, v: false });
  } catch {}

  delete processes[id];
  config.servers = config.servers.filter(s => s.id !== id);
  saveConfig(config);
  broadcast({ event: 'deleted', id });
  pushActivity(`${cfg.name} deleted`, 'red');
  return { ok: true };
}

// ── CONTAINER STATS (per container) ──
async function updateContainerStats() {
  for (const [id, state] of Object.entries(processes)) {
    if (state.status !== 'online' || !state.cfg.containerId) continue;
    try {
      const container = docker.getContainer(state.cfg.containerId);
      const stats = await container.stats({ stream: false });

      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const sysDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
      const numCPU  = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage || [1]).length;
      const cpu = sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * numCPU * 100 * 10) / 10 : 0;

      const cache    = stats.memory_stats.stats?.cache || 0;
      const memUsed  = (stats.memory_stats.usage || 0) - cache;
      const memLimit = stats.memory_stats.limit || 0;
      const memPct   = memLimit > 0 ? Math.round((memUsed / memLimit) * 100) : 0;

      state.containerStats = { cpu, memUsed, memLimit, memPct };
      broadcast({ event: 'container_stats', id, stats: state.containerStats });
    } catch {}
  }
}

// ── SYSTEM STATS ──
async function getSystemStats() {
  const [load, mem, disk, net] = await Promise.all([
    si.currentLoad(), si.mem(), si.fsSize(), si.networkStats(),
  ]);
  const mainDisk = disk.find(d => d.mount === '/' || d.mount === 'C:\\') || disk[0] || {};
  const mainNet  = net[0] || {};
  return {
    cpu: Math.round(load.currentLoad),
    ram: { used: mem.active, total: mem.total, pct: Math.round((mem.active / mem.total) * 100) },
    disk: { used: mainDisk.used || 0, total: mainDisk.size || 0, pct: mainDisk.use ? Math.round(mainDisk.use) : 0 },
    net: { rx: mainNet.rx_sec || 0, tx: mainNet.tx_sec || 0 },
  };
}

// Sync existing running containers on startup
async function syncContainerStatuses() {
  try {
    const running = await docker.listContainers({ all: true });
    config.servers.forEach(cfg => {
      const found = running.find(c =>
        c.Names.some(n => n === `/hsm-${cfg.id}`) || c.Id === cfg.containerId
      );
      const state = processes[cfg.id];
      if (!state) return;

      if (found) {
        cfg.containerId = found.Id;
        if (found.State === 'running') {
          state.status = 'online';
          state.startedAt = Date.now();
          const container = docker.getContainer(found.Id);
          attachLogStream(cfg.id, container);
          attachStdin(cfg.id, container);
        } else {
          state.status = 'offline';
        }
      }
    });
    saveConfig(config);
    console.log('  Container statuses synced.');
  } catch (err) {
    console.warn(`  Could not sync containers: ${err.message}`);
  }
}

// ── WEBSOCKET ──
const clients = new Set();
function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ── EXPRESS ──
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if (!config.panel.password) return next();
  const given = req.headers['x-panel-password'] || req.query.pw;
  if (given !== config.panel.password) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── ROUTES ──
app.get('/api/servers', auth, (req, res) => {
  res.json(config.servers.map(cfg => {
    const s = processes[cfg.id] || {};
    return {
      ...cfg,
      status: s.status || 'offline',
      startedAt: s.startedAt || null,
      restartCount: s.restartCount || 0,
      containerStats: s.containerStats || null,
    };
  }));
});

app.get('/api/servers/:id/logs', auth, (req, res) => {
  const s = processes[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s.logs.slice(-500));
});

app.post('/api/servers', auth, async (req, res) => {
  const cfg = req.body;
  if (!cfg.id || !cfg.name || !cfg.image) return res.status(400).json({ error: 'Missing id, name, or image' });
  if (config.servers.find(s => s.id === cfg.id)) return res.status(400).json({ error: 'ID already exists' });

  config.servers.push(cfg);
  saveConfig(config);
  initServer(cfg);
  broadcast({ event: 'server_added', server: { ...cfg, status: 'offline' } });
  pushActivity(`${cfg.name} added`, 'blue');
  res.json({ ok: true });
});

app.put('/api/servers/:id', auth, (req, res) => {
  const idx = config.servers.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  config.servers[idx] = { ...config.servers[idx], ...req.body };
  saveConfig(config);
  initServer(config.servers[idx]);
  broadcast({ event: 'server_updated', server: config.servers[idx] });
  res.json({ ok: true });
});

app.delete('/api/servers/:id', auth, async (req, res) => res.json(await deleteServer(req.params.id)));
app.post('/api/servers/:id/start',   auth, async (req, res) => res.json(await startServer(req.params.id)));
app.post('/api/servers/:id/stop',    auth, async (req, res) => res.json(await stopServer(req.params.id)));
app.post('/api/servers/:id/restart', auth, async (req, res) => res.json(await restartServer(req.params.id)));
app.post('/api/servers/:id/command', auth, (req, res) => res.json(sendCommand(req.params.id, req.body.command)));

app.get('/api/eggs', auth, (req, res) => res.json(loadEggs()));

app.post('/api/eggs', auth, (req, res) => {
  const egg = req.body;
  if (!egg.name) return res.status(400).json({ error: 'Missing name' });
  const id = egg.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const file = path.join(eggsPath, `${id}-custom.json`);
  if (!fs.existsSync(eggsPath)) fs.mkdirSync(eggsPath, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(egg, null, 2));
  res.json({ ok: true, id });
});

app.get('/api/stats',    auth, async (req, res) => { try { res.json(await getSystemStats()); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/activity', auth, (req, res) => res.json(activityLog.slice(0, 50)));

// Docker info endpoint
app.get('/api/docker', auth, async (req, res) => {
  try {
    const info = await docker.info();
    res.json({ ok: true, containers: info.Containers, running: info.ContainersRunning, images: info.Images, version: info.ServerVersion });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── HTTP + WS ──
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const pw  = url.searchParams.get('pw') || '';
  if (config.panel.password && pw !== config.panel.password) { ws.close(4001, 'Unauthorized'); return; }

  clients.add(ws);
  ws.send(JSON.stringify({
    event: 'snapshot',
    servers: config.servers.map(cfg => ({
      id: cfg.id,
      status: (processes[cfg.id] || {}).status || 'offline',
    })),
    activity: activityLog.slice(0, 30),
  }));
  ws.on('close', () => clients.delete(ws));
});

// Broadcast system stats every 3s, container stats every 5s
setInterval(async () => { try { broadcast({ event: 'stats', stats: await getSystemStats() }); } catch {} }, 3000);
setInterval(updateContainerStats, 5000);

// ── INIT ──
config.servers.forEach(initServer);

server.listen(config.panel.port, config.panel.host, async () => {
  console.log('\n  ┌─────────────────────────────────────┐');
  console.log(`  │  Home Server Management  v2.0        │`);
  console.log(`  │  http://localhost:${config.panel.port}              │`);
  console.log('  └─────────────────────────────────────┘\n');
  await syncContainerStatuses();
});
