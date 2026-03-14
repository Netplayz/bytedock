# API Reference

All endpoints require the `x-panel-password` header (or `?pw=` query param for WebSocket/download links).

**Base URL:** `http://your-server-ip:2999`

---

## Authentication

Every request must include your panel password:

```
x-panel-password: yourpassword
```

Responses on auth failure:
```json
{ "error": "Unauthorized" }  // 401
```

---

## Containers

### List all containers
```
GET /api/servers
```
**Response**
```json
[
  {
    "id": "my-server-1abc2def",
    "name": "My Minecraft SMP",
    "image": "itzg/minecraft-server:java21",
    "status": "online",
    "color": "emerald",
    "icon": "fa-cube",
    "ports": ["25565:25565"],
    "volumes": ["/opt/mc:/data"],
    "memory": 2048,
    "stopCommand": "stop",
    "autoRestart": false,
    "startup": "",
    "env": { "TYPE": "PAPER", "VERSION": "LATEST" },
    "dataDir": "/home/user/home-server-management/data/my-server-1abc2def",
    "containerId": "a3f2b1c4d5e6...",
    "startedAt": 1718000000000,
    "restartCount": 0,
    "containerStats": {
      "cpu": 4.2,
      "memUsed": 536870912,
      "memLimit": 2147483648,
      "memPct": 25
    }
  }
]
```

---

### Create a container
```
POST /api/servers
Content-Type: application/json
```
**Body**
```json
{
  "id": "my-server-1abc2def",
  "name": "My Minecraft SMP",
  "image": "itzg/minecraft-server:java21",
  "startup": "",
  "env": { "TYPE": "PAPER", "EULA": "TRUE" },
  "ports": ["25565:25565"],
  "volumes": [],
  "memory": 2048,
  "stopCommand": "stop",
  "autoRestart": false,
  "color": "emerald",
  "icon": "fa-cube",
  "egg": "minecraft-java"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Unique identifier (lowercase, hyphens, alphanumeric) |
| `name` | string | Yes | Display name |
| `image` | string | Yes | Docker image (e.g. `node:20-slim`) |
| `startup` | string | | Startup command. Use `{{VAR}}` for env substitution |
| `env` | object | | Environment variables injected into the container |
| `ports` | string[] | | Port bindings (`host:container`, append `/udp` for UDP) |
| `volumes` | string[] | | Bind mounts (`/host/path:/container/path`) |
| `memory` | number | | RAM limit in MB (`0` = unlimited) |
| `stopCommand` | string | | Command sent to stdin before SIGTERM |
| `autoRestart` | boolean | | Auto-restart on crash |
| `color` | string | | UI color: `indigo`, `violet`, `emerald`, `amber`, `gray` |
| `icon` | string | | Font Awesome 6 icon name (e.g. `fa-cube`) |
| `egg` | string | | Egg template `_id` used to create this container |

**Response**
```json
{ "ok": true }
```

> A per-container data directory is automatically created at `data/<id>/` inside the project folder and bind-mounted into the container at `/data`.

---

### Update a container
```
PUT /api/servers/:id
Content-Type: application/json
```
Accepts the same fields as `POST /api/servers`. Only the provided fields are updated; all others are preserved.

**Response**
```json
{ "ok": true }
```

---

### Delete a container
```
DELETE /api/servers/:id
```
Stops the container (if running), removes it from Docker, and removes it from `config.json`. The host data directory at `data/<id>/` is **not** deleted.

**Response**
```json
{ "ok": true }
```

---

### Start a container
```
POST /api/servers/:id/start
```
Pulls the image if it doesn't exist locally, creates the container if needed, then starts it.

**Response**
```json
{ "ok": true }
```

---

### Stop a container
```
POST /api/servers/:id/stop
```
Sends the configured `stopCommand` to stdin (if set), waits 5 seconds, then sends `SIGTERM`. Falls back to `docker stop --time 10`.

**Response**
```json
{ "ok": true }
```

---

### Restart a container
```
POST /api/servers/:id/restart
```

**Response**
```json
{ "ok": true }
```

---

### Send a stdin command
```
POST /api/servers/:id/command
Content-Type: application/json
```
**Body**
```json
{ "command": "say Hello world" }
```

**Response**
```json
{ "ok": true }
```

> Container must be `online`. Returns `{ "ok": false, "error": "Not running" }` otherwise.

---

### Get recent logs
```
GET /api/servers/:id/logs
```
Returns up to the last 500 log entries.

**Response**
```json
[
  { "ts": "14:23:01", "line": "Server started on port 25565", "type": "ok" },
  { "ts": "14:23:02", "line": "Done (1.234s)!", "type": "info" }
]
```

| `type` | Meaning |
|---|---|
| `info` | Standard stdout |
| `warn` | Stderr |
| `err` | Error output |
| `ok` | Startup success marker |
| `cmd` | Command sent via stdin |

---

### Upload files into a container
```
POST /api/servers/:id/upload
Content-Type: multipart/form-data
```
Injects files directly into the container filesystem via the Docker API. Works even when the container is stopped.

**Fields**

| Field | Type | Description |
|---|---|---|
| `files` | file[] | One or more files |
| `path` | string | Destination path inside the container (default: `/data`) |

**Response**
```json
{ "ok": true, "count": 2, "path": "/data" }
```

---

## File Manager

All file manager routes operate on the container's **host-side data directory** (`data/<server-id>/`). Paths are relative to that directory. Path traversal outside it is blocked.

---

### List directory
```
GET /api/servers/:id/files?path=subdir
```
`path` is relative to the container data dir. Omit for the root.

**Response**
```json
{
  "ok": true,
  "path": "configs",
  "entries": [
    { "name": "server.properties", "type": "file", "size": 1482, "mtime": 1718000000000 },
    { "name": "plugins", "type": "dir", "size": null, "mtime": 1718000000000 }
  ]
}
```

---

### Read file
```
GET /api/servers/:id/files/read?path=server.properties
```
Returns file contents as a string. Files larger than 2 MB are rejected.

**Response**
```json
{ "ok": true, "content": "#Minecraft server properties\n..." }
```

---

### Write / create file
```
POST /api/servers/:id/files/write
Content-Type: application/json
```
**Body**
```json
{ "path": "configs/server.properties", "content": "#Minecraft server properties\n..." }
```
Creates any missing parent directories automatically.

**Response**
```json
{ "ok": true }
```

---

### Create directory
```
POST /api/servers/:id/files/mkdir
Content-Type: application/json
```
**Body**
```json
{ "path": "configs/myplugin" }
```

**Response**
```json
{ "ok": true }
```

---

### Rename / move
```
POST /api/servers/:id/files/rename
Content-Type: application/json
```
**Body**
```json
{ "from": "old-name.txt", "to": "new-name.txt" }
```
Both `from` and `to` are relative to the container data dir. Can be used to move files between subdirectories.

**Response**
```json
{ "ok": true }
```

---

### Delete file or directory
```
DELETE /api/servers/:id/files
Content-Type: application/json
```
**Body**
```json
{ "path": "configs/old-plugin" }
```
Deletes files or directories recursively. **This cannot be undone.**

**Response**
```json
{ "ok": true }
```

---

### Upload files into a directory
```
POST /api/servers/:id/files/upload
Content-Type: multipart/form-data
```

| Field | Type | Description |
|---|---|---|
| `files` | file[] | One or more files |
| `path` | string | Destination subdirectory (relative, default: root) |

**Response**
```json
{ "ok": true, "count": 3 }
```

---

### Download a file
```
GET /api/servers/:id/files/download?path=server.properties&pw=yourpassword
```
Returns the raw file as a download. Use the `pw` query param since this URL is opened directly in the browser.

**Response:** Raw file bytes with `Content-Disposition: attachment`.

---

## System

### System stats
```
GET /api/stats
```
**Response**
```json
{
  "cpu": 14,
  "ram": { "used": 4294967296, "total": 17179869184, "pct": 25 },
  "disk": { "used": 53687091200, "total": 536870912000, "pct": 10 },
  "net": { "rx": 204800, "tx": 51200 }
}
```

---

### Docker info
```
GET /api/docker
```
**Response**
```json
{
  "ok": true,
  "containers": 5,
  "running": 2,
  "images": 8,
  "version": "26.1.4"
}
```

---

### Activity log
```
GET /api/activity
```
Returns the last 50 activity events.

**Response**
```json
[
  { "message": "My Minecraft SMP started", "color": "green", "time": 1718000000000 },
  { "message": "My Bot stopped", "color": "red", "time": 1717999900000 }
]
```

---

## Egg Templates

### List eggs
```
GET /api/eggs
```
Returns all egg templates loaded from the `eggs/` directory.

**Response**
```json
[
  {
    "_id": "minecraft-java",
    "name": "Minecraft Java",
    "author": "panel@netbyte.local",
    "description": "Minecraft Java Edition server.",
    "icon": "fa-cube",
    "color": "emerald",
    "docker_images": {
      "Java 21 (Recommended)": "itzg/minecraft-server:java21"
    },
    "startup": "",
    "config": { "stop": "stop", "startup_done": "Done" },
    "default_ports": ["25565:25565"],
    "default_volumes": [],
    "variables": [
      {
        "name": "Server Type",
        "description": "Paper, Spigot, Vanilla, etc.",
        "env_variable": "TYPE",
        "default_value": "PAPER",
        "field_type": "select",
        "options": ["PAPER", "SPIGOT", "VANILLA", "FORGE", "FABRIC", "PURPUR"]
      }
    ]
  }
]
```

---

### Import an egg
```
POST /api/eggs
Content-Type: application/json
```
Saves a Pterodactyl-compatible egg JSON to the `eggs/` directory.

**Body:** A valid egg JSON object (must include `"name"`).

**Response**
```json
{ "ok": true, "id": "my-custom-egg" }
```

---

## WebSocket

```
ws://your-server-ip:2999/ws?pw=yourpassword
```

Connect to receive real-time events pushed by the server. On connect you immediately receive a `snapshot` event.

### Incoming events (server → client)

#### `snapshot`
Sent immediately on connect.
```json
{
  "event": "snapshot",
  "servers": [
    { "id": "my-server-1abc", "status": "online" }
  ],
  "activity": [ ... ]
}
```

#### `status`
```json
{ "event": "status", "id": "my-server-1abc", "status": "online" }
```
`status` values: `offline` | `starting` | `online`

#### `log`
```json
{
  "event": "log",
  "id": "my-server-1abc",
  "entry": { "ts": "14:23:01", "line": "Done!", "type": "ok" }
}
```

#### `stats`
Broadcast every 3 seconds with host system stats.
```json
{
  "event": "stats",
  "stats": {
    "cpu": 14,
    "ram": { "used": 4294967296, "total": 17179869184, "pct": 25 },
    "disk": { "used": 53687091200, "total": 536870912000, "pct": 10 },
    "net": { "rx": 204800, "tx": 51200 }
  }
}
```

#### `container_stats`
Broadcast every 5 seconds per running container.
```json
{
  "event": "container_stats",
  "id": "my-server-1abc",
  "stats": { "cpu": 4.2, "memUsed": 536870912, "memLimit": 2147483648, "memPct": 25 }
}
```

#### `activity`
```json
{
  "event": "activity",
  "entry": { "message": "My Server started", "color": "green", "time": 1718000000000 }
}
```

#### `server_added`
```json
{ "event": "server_added", "server": { ...serverObject, "status": "offline" } }
```

#### `server_updated`
```json
{ "event": "server_updated", "server": { ...serverObject } }
```

#### `deleted`
```json
{ "event": "deleted", "id": "my-server-1abc" }
```

---

## Error responses

All endpoints return a consistent error shape:

```json
{ "ok": false, "error": "Human-readable error message" }
```

| HTTP status | Meaning |
|---|---|
| `400` | Bad request / validation error |
| `401` | Missing or wrong password |
| `404` | Server ID not found |
| `500` | Unexpected server error |