const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Docker = require('dockerode');
const { PassThrough, Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const os = require('os');
const si = require('systeminformation');
const multer = require('multer');

// ── DOCKER ──
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ── MULTER (memory storage, 200 MB limit) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ── CONFIG ──
const configPath = path.join(__dirname, 'config.json');
const eggsPath   = path.join(__dirname, 'eggs');

function loadConfig() { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
function saveConfig(cfg) { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2)); }
let config = loadConfig();

// ── DATA ROOT ──
// Where per-container host directories live — defaults to <project>/data/<server-id>
function getDataRoot() {
  const raw = config.panel.dataRoot || path.join(__dirname, 'data');
  if (raw.startsWith('~')) return path.join(os.homedir(), raw.slice(1));
  if (!path.isAbsolute(raw)) return path.join(__dirname, raw);
  return raw;
}

function getServerDataDir(serverId) {
  return path.join(getDataRoot(), serverId);
}

function ensureServerDataDir(serverId) {
  const dir = getServerDataDir(serverId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

// Return the container-side data path for a given egg id (defaults to /app)
function getEggDataPath(eggId) {
  if (!eggId) return '/app';
  try {
    const file = path.join(eggsPath, `${eggId}.json`);
    if (fs.existsSync(file)) {
      const egg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (egg.data_path) return egg.data_path;
    }
  } catch {}
  return '/app';
}

// ── STATE ──
const processes = {};
const activityLog = [];

function initServer(cfg) {
  if (!processes[cfg.id]) {
    processes[cfg.id] = {
      status: 'offline',
      logs: [],
      startedAt: null,
      stdinStream: null,
      containerStats: null,
      isRestarting: false,
      restartCount: 0,
      cfg,
    };
  } else {
    processes[cfg.id].cfg = cfg;
  }
}

function stripAnsi(str) {
  return String(str)
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, '')
    .replace(/\r/g, '');
}

function pushLog(id, line, type = 'info') {
  const entry = {
    ts: new Date().toLocaleTimeString('en-GB', { hour12: false }),
    line: stripAnsi(line),
    type,
  };
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

// ── TAR HELPER ──
function filesToTar(files) {
  const parts = [];

  for (const { name, buffer } of files) {
    const safeName = name.replace(/^\/+/, '').replace(/\.\.\//g, '').slice(0, 99);
    const header = Buffer.alloc(512);

    Buffer.from(safeName).copy(header, 0);
    Buffer.from('0000644\0').copy(header, 100);
    Buffer.from('0000000\0').copy(header, 108);
    Buffer.from('0000000\0').copy(header, 116);
    Buffer.from(buffer.length.toString(8).padStart(11, '0') + '\0').copy(header, 124);
    Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0').copy(header, 136);
    Buffer.from('        ').copy(header, 148);
    header[156] = 0x30;
    Buffer.from('ustar  \0').copy(header, 257);

    let chk = 0;
    for (let i = 0; i < 512; i++) chk += header[i];
    Buffer.from(chk.toString(8).padStart(6, '0') + '\0 ').copy(header, 148);

    const paddedSize = Math.ceil(buffer.length / 512) * 512;
    const content = Buffer.alloc(paddedSize);
    buffer.copy(content);

    parts.push(header, content);
  }

  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ── DOCKER HELPERS ──

async function ensureImageExists(id, image) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {}
  pushLog(id, `Pulling image: ${image} ...`, 'info');
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(err);
        pushLog(id, `Image pulled: ${image}`, 'ok');
        resolve();
      }, (event) => {
        if (['Pull complete', 'Already exists', 'Downloading', 'Extracting'].includes(event.status)) {
          pushLog(id, `  ${event.status} ${event.id || ''}`.trim(), 'info');
        }
      });
    });
  });
}

function buildStartupCmd(cfg) {
  // startupOverride takes precedence over the egg's startup template
  let cmd = (cfg.startupOverride && cfg.startupOverride.trim()) ? cfg.startupOverride : (cfg.startup || '');
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
    const [cPort, proto = 'tcp'] = parts[1].split('/');
    portBindings[`${cPort}/${proto}`] = [{ HostPort: String(hostPort) }];
    exposedPorts[`${cPort}/${proto}`] = {};
  });
  return { portBindings, exposedPorts };
}

async function getContainer(cfg) {
  const name = `hsm-${cfg.id}`;

  if (cfg.containerId) {
    try {
      const c = docker.getContainer(cfg.containerId);
      await c.inspect();
      return c;
    } catch { cfg.containerId = null; }
  }

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

  // ── Auto data directory ──
  const dataDir = ensureServerDataDir(cfg.id);
  cfg.dataDir = dataDir;
  pushLog(id, `Data directory: ${dataDir}`, 'info');

  // Resolve which path inside the container this egg uses for its data.
  // e.g. itzg/minecraft-server expects /data; generic Node/Python apps use /app.
  const containerDataPath = getEggDataPath(cfg.egg);
  pushLog(id, `Container data path: ${containerDataPath}`, 'info');

  const autoMount = `${dataDir}:${containerDataPath}`;
  const userVolumes = (cfg.volumes || []).filter(v => !v.startsWith(dataDir));
  const allBinds = [autoMount, ...userVolumes];

  pushLog(id, `Creating container: ${name}`, 'info');

  if (cfg.gpu) pushLog(id, 'GPU passthrough enabled (NVIDIA runtime required on host)', 'info');

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
    WorkingDir: containerDataPath,
    HostConfig: {
      PortBindings: portBindings,
      Binds: allBinds,
      Memory: cfg.memory ? cfg.memory * 1024 * 1024 : 0,
      RestartPolicy: { Name: 'no' },
      // GPU passthrough — requires nvidia-container-toolkit on the host
      ...(cfg.gpu ? {
        DeviceRequests: [{
          Driver: 'nvidia',
          Count: -1,
          Capabilities: [['gpu']],
        }],
      } : {}),
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
      if (!state) return;
      if (state.isRestarting) return;
      if (state.status === 'offline') return;
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
    const stream = await container.attach({
      stream: true, stdin: true, stdout: false, stderr: false, hijack: true,
    });
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
      state.isRestarting = true;
      await container.restart({ t: 10 });
      state.status = 'online';
      state.startedAt = Date.now();
      state.isRestarting = false;
      broadcast({ event: 'status', id, status: 'online' });
      attachLogStream(id, container);
      await attachStdin(id, container);
      pushActivity(`${state.cfg.name} restarted`, 'green');
    } else {
      await startServer(id);
    }
    return { ok: true };
  } catch (err) {
    state.isRestarting = false;
    return { ok: false, error: err.message };
  }
}

function sendCommand(id, cmd) {
  const state = processes[id];
  if (!state || state.status !== 'online') return { ok: false, error: 'Not running' };
  if (!state.stdinStream) return { ok: false, error: 'No stdin stream available for this container' };
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

// ── FILE UPLOAD INTO CONTAINER ──

async function uploadFilesToContainer(id, files, destPath) {
  const state = processes[id];
  if (!state) return { ok: false, error: 'Server not found' };

  let container = await getContainer(state.cfg);
  if (!container) {
    pushLog(id, 'Container not yet created — creating it to allow file upload...', 'info');
    try {
      container = await createContainer(id, state.cfg);
    } catch (err) {
      return { ok: false, error: `Could not create container: ${err.message}` };
    }
  }

  const tarBuffer = filesToTar(files);
  const tarStream = new Readable({ read() {} });
  tarStream.push(tarBuffer);
  tarStream.push(null);

  await container.putArchive(tarStream, { path: destPath });
  return { ok: true, count: files.length, path: destPath };
}

// ── CONTAINER STATS ──

async function updateContainerStats() {
  for (const [id, state] of Object.entries(processes)) {
    if (state.status !== 'online' || !state.cfg.containerId) continue;
    try {
      const container = docker.getContainer(state.cfg.containerId);
      const stats = await container.stats({ stream: false });

      const cpuDelta = (stats.cpu_stats.cpu_usage.total_usage || 0) -
                       (stats.precpu_stats.cpu_usage.total_usage || 0);
      const sysDelta = (stats.cpu_stats.system_cpu_usage || 0) -
                       (stats.precpu_stats.system_cpu_usage || 0);
      const numCPU  = stats.cpu_stats.online_cpus ||
                      (stats.cpu_stats.cpu_usage.percpu_usage || [1]).length;
      const cpu = sysDelta > 0
        ? Math.round((cpuDelta / sysDelta) * numCPU * 100 * 10) / 10
        : 0;

      const cache   = stats.memory_stats?.stats?.cache || stats.memory_stats?.stats?.inactive_file || 0;
      const memUsed  = Math.max(0, (stats.memory_stats?.usage || 0) - cache);
      const memLimit = stats.memory_stats?.limit || 0;
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
    ram: {
      used: mem.active,
      total: mem.total,
      pct: Math.round((mem.active / mem.total) * 100),
    },
    disk: {
      used: mainDisk.used || 0,
      total: mainDisk.size || 0,
      pct: mainDisk.use ? Math.round(mainDisk.use) : 0,
    },
    net: { rx: mainNet.rx_sec || 0, tx: mainNet.tx_sec || 0 },
  };
}

// ── SYNC EXISTING CONTAINERS ON STARTUP ──

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
  if (!cfg.id || !cfg.name || !cfg.image)
    return res.status(400).json({ error: 'Missing id, name, or image' });
  if (config.servers.find(s => s.id === cfg.id))
    return res.status(400).json({ error: 'ID already exists' });

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

app.delete('/api/servers/:id',           auth, async (req, res) => res.json(await deleteServer(req.params.id)));
app.post('/api/servers/:id/start',       auth, async (req, res) => res.json(await startServer(req.params.id)));
app.post('/api/servers/:id/stop',        auth, async (req, res) => res.json(await stopServer(req.params.id)));
app.post('/api/servers/:id/restart',     auth, async (req, res) => res.json(await restartServer(req.params.id)));
app.post('/api/servers/:id/command',     auth, (req, res) => res.json(sendCommand(req.params.id, req.body.command)));

// ── FILE UPLOAD INTO CONTAINER ──
app.post('/api/servers/:id/upload', auth, upload.array('files'), async (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No files provided' });

  const destPath = (req.body.path || '/data').trim() || '/data';
  const files = req.files.map(f => ({
    name: f.originalname,
    buffer: f.buffer,
  }));

  try {
    const result = await uploadFilesToContainer(id, files, destPath);
    if (!result.ok) return res.status(400).json(result);
    pushActivity(`${processes[id].cfg.name}: ${files.length} file(s) uploaded to ${destPath}`, 'blue');
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── FILE MANAGER ROUTES ──

function resolveDataPath(serverId, rel) {
  const base = getServerDataDir(serverId);
  const resolved = path.resolve(base, rel || '.');
  if (!resolved.startsWith(base)) throw new Error('Path traversal denied');
  return { base, resolved };
}

app.get('/api/servers/:id/files', auth, (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  try {
    const { base, resolved } = resolveDataPath(id, req.query.path || '');
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    const entries = fs.readdirSync(resolved).map(name => {
      const full = path.join(resolved, name);
      let s;
      try { s = fs.statSync(full); } catch { return null; }
      return {
        name,
        type: s.isDirectory() ? 'dir' : 'file',
        size: s.isDirectory() ? null : s.size,
        mtime: s.mtimeMs,
      };
    }).filter(Boolean);

    const relPath = path.relative(base, resolved) || '';
    res.json({ ok: true, path: relPath, entries });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/servers/:id/files/read', auth, (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  try {
    const { resolved } = resolveDataPath(id, req.query.path || '');
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    if (stat.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'File too large to edit (>2 MB)' });
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ ok: true, content });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/servers/:id/files/write', auth, (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  try {
    const { resolved } = resolveDataPath(id, req.body.path || '');
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, req.body.content || '', 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/servers/:id/files/mkdir', auth, (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  try {
    const { resolved } = resolveDataPath(id, req.body.path || '');
    fs.mkdirSync(resolved, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/servers/:id/files/rename', auth, (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  try {
    const { resolved: from } = resolveDataPath(id, req.body.from || '');
    const { resolved: to }   = resolveDataPath(id, req.body.to   || '');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/servers/:id/files', auth, (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  try {
    const { resolved } = resolveDataPath(id, req.body.path || '');
    fs.rmSync(resolved, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/servers/:id/files/upload', auth, upload.array('files'), (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files provided' });
  try {
    const { resolved: destDir } = resolveDataPath(id, req.body.path || '');
    fs.mkdirSync(destDir, { recursive: true });
    req.files.forEach(f => {
      const dest = path.join(destDir, f.originalname);
      fs.writeFileSync(dest, f.buffer);
    });
    res.json({ ok: true, count: req.files.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/servers/:id/files/download', auth, (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  try {
    const { resolved } = resolveDataPath(id, req.query.path || '');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
      return res.status(404).json({ error: 'File not found' });
    res.download(resolved);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

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

// ── MOD SEARCH PROXY ──
// Uses Modrinth (no key needed) and CurseForge (requires config.panel.curseforgeApiKey)

const https = require('https');

// Fake browser User-Agent used for CurseForge file downloads
// (CurseForge CDN blocks non-browser UAs on direct download URLs)
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Firefox/125.0';

// httpsGet — JSON API helper (keeps ByteDock UA by default)
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    https.get({ hostname: opts.hostname, path: opts.pathname + opts.search, headers: { 'User-Agent': 'ByteDock/2.2', ...headers } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

// httpsDownload — binary download helper that follows redirects and accepts a custom UA
function httpsDownload(url, ua = 'ByteDock/2.2', maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function follow(currentUrl, remaining) {
      if (remaining <= 0) return reject(new Error('Too many redirects'));
      const urlObj = new URL(currentUrl);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers: {
          'User-Agent': ua,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      };
      https.get(options, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          const next = r.headers.location.startsWith('http')
            ? r.headers.location
            : `https://${urlObj.hostname}${r.headers.location}`;
          return follow(next, remaining - 1);
        }
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks)));
        r.on('error', reject);
      }).on('error', reject);
    }
    follow(url, maxRedirects);
  });
}

app.get('/api/mods/search', auth, async (req, res) => {
  const { q = '', source = 'modrinth', loader = '', version = '' } = req.query;

  try {
    if (source === 'modrinth') {
      const facets = [['project_type:mod']];
      if (loader)  facets.push([`categories:${loader}`]);
      if (version) facets.push([`versions:${version}`]);
      const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=24&index=relevance`;
      const r = await httpsGet(url);
      if (r.status !== 200) return res.status(502).json({ ok: false, error: 'Modrinth API error' });
      const mods = (r.body.hits || []).map(m => ({
        id: m.project_id,
        slug: m.slug,
        name: m.title,
        description: m.description,
        icon: m.icon_url || null,
        author: m.author,
        downloads: m.downloads,
        categories: m.categories || [],
        source: 'modrinth',
        url: `https://modrinth.com/mod/${m.slug}`,
      }));
      return res.json({ ok: true, mods });
    }

    if (source === 'curseforge') {
      const apiKey = config.panel.curseforgeApiKey;
      if (!apiKey) return res.status(400).json({ ok: false, error: 'No CurseForge API key configured. Add curseforgeApiKey to config.json → panel.' });
      const loaderMap = { fabric: 4, forge: 1, quilt: 5, neoforge: 6 };
      let url = `https://api.curseforge.com/v1/mods/search?gameId=432&searchFilter=${encodeURIComponent(q)}&pageSize=24&sortField=2&sortOrder=desc`;
      if (loaderMap[loader]) url += `&modLoaderType=${loaderMap[loader]}`;
      if (version) url += `&gameVersion=${encodeURIComponent(version)}`;
      const r = await httpsGet(url, { 'x-api-key': apiKey });
      if (r.status !== 200) return res.status(502).json({ ok: false, error: 'CurseForge API error' });
      const mods = (r.body.data || []).map(m => ({
        id: String(m.id),
        slug: m.slug,
        name: m.name,
        description: m.summary,
        icon: m.logo?.url || null,
        author: (m.authors || []).map(a => a.name).join(', '),
        downloads: m.downloadCount,
        categories: (m.categories || []).map(c => c.name),
        source: 'curseforge',
        url: m.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`,
      }));
      return res.json({ ok: true, mods });
    }

    // ── Modrinth modpack search ──
    if (source === 'modpack-modrinth') {
      const facets = [['project_type:modpack']];
      if (loader)  facets.push([`categories:${loader}`]);
      if (version) facets.push([`versions:${version}`]);
      const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=24&index=relevance`;
      const r = await httpsGet(url);
      if (r.status !== 200) return res.status(502).json({ ok: false, error: 'Modrinth API error' });
      const mods = (r.body.hits || []).map(m => ({
        id: m.project_id,
        slug: m.slug,
        name: m.title,
        description: m.description,
        icon: m.icon_url || null,
        author: m.author,
        downloads: m.downloads,
        categories: m.categories || [],
        game_versions: m.game_versions || [],
        source: 'modpack-modrinth',
        url: `https://modrinth.com/modpack/${m.slug}`,
      }));
      return res.json({ ok: true, mods });
    }

    // ── CurseForge modpack search (classId 4471 = Modpacks) ──
    if (source === 'modpack-curseforge') {
      const apiKey = config.panel.curseforgeApiKey;
      if (!apiKey) return res.status(400).json({ ok: false, error: 'No CurseForge API key configured. Add curseforgeApiKey to config.json → panel.' });
      const loaderMap = { fabric: 4, forge: 1, quilt: 5, neoforge: 6 };
      let url = `https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&searchFilter=${encodeURIComponent(q)}&pageSize=24&sortField=2&sortOrder=desc`;
      if (loaderMap[loader]) url += `&modLoaderType=${loaderMap[loader]}`;
      if (version) url += `&gameVersion=${encodeURIComponent(version)}`;
      const r = await httpsGet(url, { 'x-api-key': apiKey });
      if (r.status !== 200) return res.status(502).json({ ok: false, error: 'CurseForge API error' });
      const mods = (r.body.data || []).map(m => ({
        id: String(m.id),
        slug: m.slug,
        name: m.name,
        description: m.summary,
        icon: m.logo?.url || null,
        author: (m.authors || []).map(a => a.name).join(', '),
        downloads: m.downloadCount,
        categories: (m.categories || []).map(c => c.name),
        game_versions: (m.latestFilesIndexes || []).map(f => f.gameVersion).filter(Boolean),
        source: 'modpack-curseforge',
        url: m.links?.websiteUrl || `https://www.curseforge.com/minecraft/modpacks/${m.slug}`,
      }));
      return res.json({ ok: true, mods });
    }

    res.status(400).json({ ok: false, error: 'Unknown source' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET latest file URL for a mod version
app.get('/api/mods/versions', auth, async (req, res) => {
  const { id, source = 'modrinth', loader = '', version = '' } = req.query;
  if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });

  try {
    if (source === 'modrinth') {
      let url = `https://api.modrinth.com/v2/project/${id}/version?limit=20`;
      if (loader)  url += `&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
      if (version) url += `&game_versions=${encodeURIComponent(JSON.stringify([version]))}`;
      const r = await httpsGet(url);
      if (r.status !== 200) return res.status(502).json({ ok: false, error: 'Modrinth API error' });
      const versions = (r.body || []).map(v => ({
        id: v.id,
        name: v.name,
        version_number: v.version_number,
        game_versions: v.game_versions,
        loaders: v.loaders,
        files: (v.files || []).filter(f => f.primary || f.filename?.endsWith('.jar')).map(f => ({
          name: f.filename,
          url: f.url,
          size: f.size,
        })),
      }));
      return res.json({ ok: true, versions });
    }

    if (source === 'curseforge') {
      const apiKey = config.panel.curseforgeApiKey;
      if (!apiKey) return res.status(400).json({ ok: false, error: 'No CurseForge API key configured.' });
      let url = `https://api.curseforge.com/v1/mods/${id}/files?pageSize=20`;
      if (version) url += `&gameVersion=${encodeURIComponent(version)}`;
      const r = await httpsGet(url, { 'x-api-key': apiKey });
      if (r.status !== 200) return res.status(502).json({ ok: false, error: 'CurseForge API error' });
      const versions = (r.body.data || []).map(f => ({
        id: String(f.id),
        name: f.displayName,
        version_number: f.fileName,
        game_versions: f.gameVersions,
        loaders: [],
        files: [{ name: f.fileName, url: f.downloadUrl, size: f.fileLength }],
      }));
      return res.json({ ok: true, versions });
    }

    res.status(400).json({ ok: false, error: 'Unknown source' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── MOD INSTALL ──
// Downloads a mod file into the server's mods folder.
// CurseForge CDN requires a real browser User-Agent — we spoof Windows Chrome/Firefox.
app.post('/api/servers/:id/mods/install', auth, async (req, res) => {
  const { id } = req.params;
  const { fileUrl, fileName, destPath = 'mods', source = 'modrinth' } = req.body;

  if (!processes[id]) return res.status(404).json({ ok: false, error: 'Server not found' });
  if (!fileUrl || !fileName) return res.status(400).json({ ok: false, error: 'Missing fileUrl or fileName' });

  try {
    const { resolved: destDir } = resolveDataPath(id, destPath);
    fs.mkdirSync(destDir, { recursive: true });

    const filePath = path.join(destDir, fileName);

    // CurseForge CDN blocks non-browser UAs; use a fake Windows Chrome UA for those downloads.
    const ua = source === 'curseforge' ? BROWSER_UA : 'ByteDock/2.2';
    const fileBuffer = await httpsDownload(fileUrl, ua);

    fs.writeFileSync(filePath, fileBuffer);
    pushActivity(`${processes[id].cfg.name}: mod "${fileName}" installed from ${source}`, 'blue');
    res.json({ ok: true, path: path.join(destPath, fileName), size: fileBuffer.length, source });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── MOD SIDE CHECK ──
// Returns whether a mod is client-side, server-side, or both.
// Uses Modrinth project API or CurseForge mod API depending on source.
//
// GET /api/mods/side?id=<modId>&source=modrinth|curseforge
//
// Response:
//   { ok, id, name, clientSide, serverSide, side }
//   side: "client" | "server" | "both" | "unknown"

app.get('/api/mods/side', auth, async (req, res) => {
  const { id, source = 'modrinth' } = req.query;
  if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });

  try {
    if (source === 'modrinth') {
      const r = await httpsGet(`https://api.modrinth.com/v2/project/${id}`);
      if (r.status !== 200) return res.status(502).json({ ok: false, error: 'Modrinth API error' });
      const p = r.body;
      // Modrinth side values: "required" | "optional" | "unsupported"
      const clientRequired = p.client_side === 'required' || p.client_side === 'optional';
      const serverRequired = p.server_side === 'required' || p.server_side === 'optional';
      const clientOnly = clientRequired && (p.server_side === 'unsupported');
      const serverOnly = serverRequired && (p.client_side === 'unsupported');
      const side = clientOnly ? 'client' : serverOnly ? 'server' : (clientRequired || serverRequired) ? 'both' : 'unknown';
      return res.json({
        ok: true,
        id,
        name: p.title,
        clientSide: p.client_side,
        serverSide: p.server_side,
        side,
        source: 'modrinth',
      });
    }

    if (source === 'curseforge') {
      const apiKey = config.panel.curseforgeApiKey;
      if (!apiKey) return res.status(400).json({ ok: false, error: 'No CurseForge API key configured.' });
      const r = await httpsGet(`https://api.curseforge.com/v1/mods/${id}`, { 'x-api-key': apiKey });
      if (r.status !== 200) return res.status(502).json({ ok: false, error: 'CurseForge API error' });
      const m = r.body.data;
      // CurseForge does not expose a structured client/server side field — we infer from categories.
      const cats = (m.categories || []).map(c => c.name.toLowerCase());
      const isClientSide = cats.some(c => c.includes('client'));
      const isServerSide = cats.some(c => c.includes('server'));
      const side = (isClientSide && !isServerSide) ? 'client'
                 : (!isClientSide && isServerSide) ? 'server'
                 : (isClientSide && isServerSide)  ? 'both'
                 : 'unknown';
      return res.json({
        ok: true,
        id,
        name: m.name,
        clientSide: isClientSide ? 'required' : 'unknown',
        serverSide: isServerSide ? 'required' : 'unknown',
        side,
        source: 'curseforge',
      });
    }

    res.status(400).json({ ok: false, error: 'Unknown source. Use modrinth or curseforge.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── MOD SIDE SCAN + AUTO-DELETE ──
// Scans all .jar files in a server's mods folder, checks each one's side via
// Modrinth (by filename slug lookup), and deletes any that are client-only.
//
// POST /api/servers/:id/mods/scan-and-clean
// Body: { modsPath: "mods" }   (optional, defaults to "mods")
//
// This only works for mods that exist on Modrinth and whose filename can be
// matched to a version. Mods it cannot identify are left untouched (safe=true).

// ── SCAN & CLEAN CLIENT MODS ──
// Strategy 1 (primary): Parse the server's own crash logs for
//   "Attempted to load class ... for invalid dist DEDICATED_SERVER"
//   These lines name the exact mod jar that failed — no API required.
// Strategy 2 (fallback): Query Modrinth by filename for any jars not caught by logs.

app.post('/api/servers/:id/mods/scan-and-clean', auth, async (req, res) => {
  const { id } = req.params;
  const { modsPath = 'mods' } = req.body;

  if (!processes[id]) return res.status(404).json({ ok: false, error: 'Server not found' });

  try {
    const { resolved: modsDir } = resolveDataPath(id, modsPath);
    if (!fs.existsSync(modsDir)) return res.status(404).json({ ok: false, error: 'Mods directory not found' });

    const files = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
    const results = [];

    // ── Strategy 1: detect from crash logs ──
    // Forge logs the failing mod file path in the mod list section, and the error
    // "Attempted to load class X for invalid dist DEDICATED_SERVER" nearby.
    // We look for lines like:
    //   "Mod File: /data/mods/smoothswapping-0.9.2-1.19.2-forge.jar"
    // followed (anywhere in the log window) by the dist error.
    const logs = processes[id].logs || [];
    const crashedJars = new Set();

    // Collect all mod files mentioned near dist errors
    // Forge groups them: "-- MOD name --" → "Mod File: /path/to/jar" → error
    let currentModFile = null;
    for (const entry of logs) {
      const line = entry.line || '';

      const modFileMatch = line.match(/Mod File:\s*(.+\.jar)/i);
      if (modFileMatch) {
        currentModFile = path.basename(modFileMatch[1].trim());
      }

      if (/invalid dist DEDICATED_SERVER/i.test(line) && currentModFile) {
        crashedJars.add(currentModFile);
        currentModFile = null;
      }
    }

    // Also catch the summary lines: "smoothswapping has failed to load correctly"
    // paired with the dist error in the same log session
    const failedModIds = new Set();
    for (const entry of logs) {
      const line = entry.line || '';
      const failMatch = line.match(/(\w+) has failed to load correctly/i);
      if (failMatch) failedModIds.add(failMatch[1].toLowerCase());
    }

    // Match failed mod IDs to actual jar filenames
    for (const file of files) {
      const lower = file.toLowerCase();
      for (const modId of failedModIds) {
        if (lower.includes(modId)) {
          crashedJars.add(file);
        }
      }
    }

    // ── Delete crash-detected jars immediately (no API needed) ──
    const logDeleted = new Set();
    for (const jarFile of crashedJars) {
      if (files.includes(jarFile)) {
        const fullPath = path.join(modsDir, jarFile);
        try {
          fs.rmSync(fullPath, { force: true });
          logDeleted.add(jarFile);
          pushLog(id, `[scan-and-clean] Deleted client-only mod (crash log): ${jarFile}`, 'warn');
        } catch (e) {
          pushLog(id, `[scan-and-clean] Failed to delete ${jarFile}: ${e.message}`, 'err');
        }
      }
    }

    // ── Strategy 2: Modrinth API check for remaining jars ──
    for (const file of files) {
      if (logDeleted.has(file)) {
        results.push({ file, modName: file, side: 'client', action: 'deleted', reason: 'Crashed server with invalid dist DEDICATED_SERVER error' });
        continue;
      }

      let action = 'kept';
      let side = 'unknown';
      let modName = file;
      let reason = 'Could not identify mod';

      try {
        const query = file.replace(/[-_][0-9].*$/, '').replace(/[-_]/g, ' ').trim();
        const searchR = await httpsGet(
          `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(JSON.stringify([['project_type:mod']]))}&limit=5`
        );

        if (searchR.status === 200 && searchR.body.hits?.length > 0) {
          const hit = searchR.body.hits[0];
          const projectR = await httpsGet(`https://api.modrinth.com/v2/project/${hit.project_id}`);
          if (projectR.status === 200) {
            const p = projectR.body;
            modName = p.title;
            const serverOk = p.server_side !== 'unsupported';
            side = (!serverOk) ? 'client' : 'both';

            if (side === 'client') {
              fs.rmSync(path.join(modsDir, file), { force: true });
              action = 'deleted';
              reason = `Client-only mod (server_side=${p.server_side})`;
              pushLog(id, `[scan-and-clean] Deleted client-only mod (Modrinth): ${file} (${p.title})`, 'warn');
            } else {
              reason = `Side: ${side} (server_side=${p.server_side})`;
            }
          }
        }
      } catch (e) {
        reason = `Modrinth check failed: ${e.message}`;
      }

      results.push({ file, modName, side, action, reason });
    }

    const deleted = results.filter(r => r.action === 'deleted').length;
    pushActivity(`${processes[id].cfg.name}: scan-and-clean — ${deleted} client-only mod(s) removed`, deleted > 0 ? 'yellow' : 'blue');
    res.json({ ok: true, scanned: files.length, deleted, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── MODPACK INSTALL ──
// Configures the itzg/minecraft-server container to use a modpack via env vars,
// then restarts the container so the image bootstraps the pack on next startup.
app.post('/api/servers/:id/modpacks/install', auth, async (req, res) => {
  const { id } = req.params;
  const { source, modpackSlug, modpackName, version } = req.body;

  const state = processes[id];
  if (!state) return res.status(404).json({ ok: false, error: 'Server not found' });

  const cfg = state.cfg;
  const newEnv = { ...(cfg.env || {}) };

  try {
    if (source === 'modpack-modrinth') {
      // itzg/minecraft-server: TYPE=MODRINTH + MODRINTH_MODPACK=<slug> or <slug:version>
      newEnv.TYPE = 'MODRINTH';
      newEnv.MODRINTH_MODPACK = version ? `${modpackSlug}:${version}` : modpackSlug;
      // Remove conflicting CurseForge modpack vars
      delete newEnv.CF_SLUG;
      delete newEnv.CF_PAGE_URL;
      delete newEnv.CF_FILENAME_MATCHER;
      delete newEnv.CF_API_KEY;
    } else if (source === 'modpack-curseforge') {
      const apiKey = config.panel.curseforgeApiKey;
      if (!apiKey) return res.status(400).json({ ok: false, error: 'No CurseForge API key configured. Add curseforgeApiKey to config.json → panel.' });
      // itzg/minecraft-server: TYPE=AUTO_CURSEFORGE + CF_SLUG + optional CF_FILENAME_MATCHER
      newEnv.TYPE = 'AUTO_CURSEFORGE';
      newEnv.CF_SLUG = modpackSlug;
      newEnv.CF_API_KEY = apiKey;
      if (version) newEnv.CF_FILENAME_MATCHER = version;
      else delete newEnv.CF_FILENAME_MATCHER;
      // Remove conflicting Modrinth modpack vars
      delete newEnv.MODRINTH_MODPACK;
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown modpack source' });
    }

    // Persist updated env to config so it survives ByteDock restarts
    cfg.env = newEnv;
    const idx = config.servers.findIndex(s => s.id === id);
    if (idx !== -1) {
      config.servers[idx].env = newEnv;
      saveConfig(config);
    }

    pushActivity(`${cfg.name}: modpack "${modpackName}" configured — restarting`, 'violet');

    // Stop then start so the container is re-created with the new env
    await stopServer(id);
    await startServer(id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/stats',    auth, async (req, res) => {
  try { res.json(await getSystemStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/activity', auth, (req, res) => res.json(activityLog.slice(0, 50)));

app.get('/api/docker', auth, async (req, res) => {
  try {
    const info = await docker.info();
    res.json({
      ok: true,
      containers: info.Containers,
      running: info.ContainersRunning,
      images: info.Images,
      version: info.ServerVersion,
    });
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
  if (config.panel.password && pw !== config.panel.password) {
    ws.close(4001, 'Unauthorized');
    return;
  }

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

setInterval(async () => {
  try { broadcast({ event: 'stats', stats: await getSystemStats() }); } catch {}
}, 3000);
setInterval(updateContainerStats, 5000);

// ── INIT ──
config.servers.forEach(initServer);

server.listen(config.panel.port, config.panel.host, async () => {
  console.log('\n  ┌─────────────────────────────────────┐');
  console.log(`    │  bytedock  v2.1                     │`);
  console.log(`    │http://localhost:${config.panel.port}│`);
  console.log('    └─────────────────────────────────────┘\n');
  await syncContainerStatuses();
});
