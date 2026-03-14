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
  // Expand ~ or relative paths
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

// ── STATE ──
// id → { status, logs, startedAt, stdinStream, cfg, isRestarting }
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
// Creates a valid tar archive buffer from an array of { name, buffer } objects.
function filesToTar(files) {
  const parts = [];

  for (const { name, buffer } of files) {
    // Sanitise filename — strip any leading slashes / path traversal
    const safeName = name.replace(/^\/+/, '').replace(/\.\.\//g, '').slice(0, 99);
    const header = Buffer.alloc(512);

    Buffer.from(safeName).copy(header, 0);
    Buffer.from('0000644\0').copy(header, 100);  // mode
    Buffer.from('0000000\0').copy(header, 108);  // uid
    Buffer.from('0000000\0').copy(header, 116);  // gid
    Buffer.from(buffer.length.toString(8).padStart(11, '0') + '\0').copy(header, 124);  // size
    Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0').copy(header, 136);  // mtime
    Buffer.from('        ').copy(header, 148);   // checksum placeholder (8 spaces)
    header[156] = 0x30;                          // type '0' = regular file
    Buffer.from('ustar  \0').copy(header, 257);  // magic

    // Calculate checksum (treating checksum field as spaces)
    let chk = 0;
    for (let i = 0; i < 512; i++) chk += header[i];
    Buffer.from(chk.toString(8).padStart(6, '0') + '\0 ').copy(header, 148);

    // Pad file content to a multiple of 512 bytes
    const paddedSize = Math.ceil(buffer.length / 512) * 512;
    const content = Buffer.alloc(paddedSize);
    buffer.copy(content);

    parts.push(header, content);
  }

  // End-of-archive marker: two 512-byte zero blocks
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
    const [cPort, proto = 'tcp'] = parts[1].split('/');
    portBindings[`${cPort}/${proto}`] = [{ HostPort: String(hostPort) }];
    exposedPorts[`${cPort}/${proto}`] = {};
  });
  return { portBindings, exposedPorts };
}

async function getContainer(cfg) {
  const name = `hsm-${cfg.id}`;

  // Try by stored container ID
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

  // ── Auto data directory in user's home ──
  const dataDir = ensureServerDataDir(cfg.id);
  cfg.dataDir = dataDir;   // persist so the UI can display it
  pushLog(id, `Data directory: ${dataDir}`, 'info');

  // Prepend the auto-mount; user-specified volumes still apply on top
  const autoMount = `${dataDir}:/data`;
  const userVolumes = (cfg.volumes || []).filter(v => !v.startsWith(dataDir));
  const allBinds = [autoMount, ...userVolumes];

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
      Binds: allBinds,
      Memory: cfg.memory ? cfg.memory * 1024 * 1024 : 0,
      RestartPolicy: { Name: 'no' },
    },
  };

  if (startup) opts.Cmd = ['/bin/sh', '-c', startup];

  const container = await docker.createContainer(opts);

  // Update cfg in-place so config.servers is also updated (same object reference)
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

      // Skip offline transition if we're in the middle of a manual restart
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
      // Flag as restarting so the log stream 'end' handler doesn't fire auto-restart
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
    // Container hasn't been created yet — create it without starting
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

// ── CONTAINER STATS (per container) ──

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

      // cgroup v1 uses memory_stats.stats.cache, cgroup v2 may not expose it
      const cache   = stats.memory_stats?.stats?.cache || stats.memory_stats?.stats?.inactive_file || 0;
      const memUsed  = Math.max(0, (stats.memory_stats?.usage || 0) - cache);
      const memLimit = stats.memory_stats?.limit || 0;
      const memPct   = memLimit > 0 ? Math.round((memUsed / memLimit) * 100) : 0;

      state.containerStats = { cpu, memUsed, memLimit, memPct };
      broadcast({ event: 'container_stats', id, stats: state.containerStats });
    } catch { /* container may have been removed */ }
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

// ── FILE UPLOAD ──
app.post('/api/servers/:id/upload', auth, upload.array('files'), async (req, res) => {
  const { id } = req.params;
  if (!processes[id]) return res.status(404).json({ error: 'Server not found' });
  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No files provided' });

  const destPath = (req.body.path || '/app').trim() || '/app';
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

// Resolve and validate a path inside a server's data directory
function resolveDataPath(serverId, rel) {
  const base = getServerDataDir(serverId);
  const resolved = path.resolve(base, rel || '.');
  if (!resolved.startsWith(base)) throw new Error('Path traversal denied');
  return { base, resolved };
}

// GET /api/servers/:id/files?path=subdir  — list directory
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

    // Relative path from base for the breadcrumb
    const relPath = path.relative(base, resolved) || '';
    res.json({ ok: true, path: relPath, entries });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /api/servers/:id/files/read?path=file.txt  — read file contents
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

// POST /api/servers/:id/files/write  — write file contents
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

// POST /api/servers/:id/files/mkdir  — create directory
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

// POST /api/servers/:id/files/rename  — rename/move
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

// DELETE /api/servers/:id/files  — delete file or directory
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

// POST /api/servers/:id/files/upload  — upload files into a directory
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

// GET /api/servers/:id/files/download?path=file.txt  — download a file
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

// Broadcast system stats every 3 s, container stats every 5 s
setInterval(async () => {
  try { broadcast({ event: 'stats', stats: await getSystemStats() }); } catch {}
}, 3000);
setInterval(updateContainerStats, 5000);

// ── INIT ──
config.servers.forEach(initServer);

server.listen(config.panel.port, config.panel.host, async () => {
  console.log('\n  ┌─────────────────────────────────────┐');
  console.log(`  │  Home Server Management  v2.1        │`);
  console.log(`  │  http://localhost:${config.panel.port}              │`);
  console.log('  └─────────────────────────────────────┘\n');
  await syncContainerStatuses();
});
