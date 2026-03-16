#  ByteDock

A personal self-hosted server management panel powered by **Docker**. Deploy and manage containers using **Pterodactyl-style egg templates** — all from a clean, dark web UI.

Built for personal use. No cloud dependency, no accounts, no bloat.

---

##  Features

- **Docker-native** — containers are created, started, stopped, and deleted via the Docker API
- **Egg templates** — Pterodactyl-compatible eggs define images, env variables, ports, and startup commands
- **File upload** — import any community Pterodactyl egg `.json` with drag-and-drop
- **Live console** — real-time stdout/stderr streamed via WebSocket, with stdin command support
- **Resource monitoring** — live CPU, RAM, disk, and network stats for the host and per-container
- **Activity log** — timestamped event feed for all container lifecycle events
- **Password protected** — simple password gate on both the REST API and WebSocket
- **Auto-restart** — optional per-container crash recovery
- **Persistent config** — all servers saved to `config.json`, survives restarts

---

##  Built-in Eggs

| Egg | Image |
|---|---|
| Minecraft Java | `itzg/minecraft-server` (Paper, Spigot, Fabric, Forge, Vanilla) |
| Minecraft Bedrock | `itzg/minecraft-bedrock-server` |
| Node.js Web App | `node:20-slim` |
| Python App | `python:3.12-slim` |
| Custom Docker | any image |

You can import additional eggs from the [Pterodactyl community eggs repo](https://github.com/parkervcp/eggs) using the Import button.

---

##  Quick Start

### Requirements

- [Node.js](https://nodejs.org/) v18+
- [Docker](https://docs.docker.com/engine/install/) running on the host
- Your user in the `docker` group

```bash
sudo usermod -aG docker $USER && newgrp docker
```

### Install & Run

```bash
git clone https://github.com/Netplayz/bytedock.git
cd bytedock
chmod +x start.sh && ./start.sh
```

Or manually:

```bash
npm install
node server.js
```

Then open **http://your-server-ip:2999**

Default password: `changeme` — change it in `config.json` before exposing to a network.

---

##  Configuration

Edit `config.json` before starting:

```json
{
  "panel": {
    "port": 2999,
    "host": "0.0.0.0",
    "password": "yourpassword"
  },
  "servers": []
}
```

Servers are added and saved automatically through the UI. The `servers` array is managed by the panel — you don't need to edit it manually.

---

##  Adding Eggs

### From the UI (recommended)

1. Sidebar → **Egg Templates** → **Import Egg**
2. Click the drop zone or drag `.json` files onto it
3. Supports multiple files at once

### From the filesystem

Drop any egg `.json` file into the `eggs/` folder and restart the panel. It will be picked up automatically.

### Writing your own egg

```json
{
  "name": "My App",
  "author": "you@example.com",
  "description": "Short description shown in the UI.",
  "icon": "fa-globe",
  "color": "indigo",
  "docker_images": {
    "Node 20 LTS": "node:20-slim"
  },
  "startup": "cd /app && npm install && node {{ENTRY_FILE}}",
  "config": {
    "stop": null,
    "startup_done": "listening"
  },
  "default_ports": ["3000:3000"],
  "default_volumes": [],
  "variables": [
    {
      "name": "Entry File",
      "description": "Main JS file to run.",
      "env_variable": "ENTRY_FILE",
      "default_value": "index.js",
      "field_type": "text"
    }
  ]
}
```

**Field types:** `text`, `select` (add `"options": ["a","b","c"]`)  
**Icons:** any [Font Awesome 6](https://fontawesome.com/icons) solid icon name  
**Colors:** `indigo`, `violet`, `emerald`, `amber`, `gray`

---

##  Docker Notes

### Container naming

All containers are named `hsm-<server-id>` so they're identifiable in `docker ps`.

### Volumes / persistent data

Mount host directories using the **Volumes** field when creating a container:

```
/opt/myserver:/data
```

The panel never deletes volume data when removing a container — only the container itself is removed.

### Ports

Use the format `host:container` or `host:container/udp` for UDP:

```
25565:25565
19132:19132/udp
```

### Memory limits

Set a value in MB to cap container RAM. Leave `0` for no limit.

---

##  Security

- Change `password` in `config.json` from the default `changeme`
- Bind to `127.0.0.1` and use a reverse proxy (Nginx + Certbot) for HTTPS if exposing externally
- The panel does not run containers as root — it inherits your user's Docker socket permissions

### Nginx reverse proxy (optional)

```nginx
server {
    server_name panel.yourdomain.com;

    location / {
        proxy_pass http://localhost:2999;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Then: `sudo certbot --nginx -d panel.yourdomain.com`

### Run as a systemd service

```bash
sudo tee /etc/systemd/system/bytedock.service > /dev/null <<EOF
[Unit]
Description=bytedock
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(which node) server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now home-panel
```

---

##  Project Structure

```
home-server-management/
├── server.js          # Express + WebSocket backend
├── config.json        # Panel config and saved servers
├── package.json
├── start.sh           # Quick-start script
├── eggs/              # Egg template JSON files
│   ├── minecraft-java.json
│   ├── minecraft-bedrock.json
│   ├── nodejs-web.json
│   ├── python-app.json
│   └── custom.json
│   └── minecraft-crossplay-playit.json
└── public/
    └── index.html     # Single-file frontend
```

---

## Stack

- **Backend** — Node.js, Express, `ws`, `dockerode`, `systeminformation`
- **Frontend** — Vanilla HTML/CSS/JS, Inter + JetBrains Mono, Font Awesome 6
- **Design** — Dark theme (`#0f121b`), indigo/violet accent palette

---

## License

GPL 3.0 


---

*Built by [NetByte](https://github.com/netplayz)*

*With the assistance of [Claude Sonnet 4.5](https://www.anthropic.com/news/claude-sonnet-4-5)*

*Inspired by WispByte, thank you David Dobos*




