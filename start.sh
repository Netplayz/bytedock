#!/bin/bash
set -e

# Check Docker
if ! docker info &>/dev/null 2>&1; then
  echo "ERROR: Docker is not running or not accessible."
  echo "Make sure Docker is installed and your user is in the docker group:"
  echo "  sudo usermod -aG docker $USER && newgrp docker"
  exit 1
fi

echo "Docker: OK"
echo "Installing Node dependencies..."
npm install

echo ""
echo "Starting Home Server Management..."
echo "Open: http://$(hostname -I | awk '{print $1}' 2>/dev/null || echo localhost):2999"
echo "Password: $(node -e "const c=require('./config.json');console.log(c.panel.password||'(none)')")"
echo ""
node server.js
