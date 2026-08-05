#!/usr/bin/env bash
# OPEN Booru — Linux installer (Arch / Ubuntu / Debian / Fedora)
# English console output.
#
# From anywhere:
#   curl -fsSL https://raw.githubusercontent.com/RegentsVoice/OPEN_Booru/main/scripts/install-linux.sh | bash
#
# Inside a cloned repo:
#   chmod +x scripts/install-linux.sh && ./scripts/install-linux.sh
set -euo pipefail

REPO_URL="${OPEN_BOORU_REPO:-https://github.com/RegentsVoice/OPEN_Booru.git}"
REPO_NAME="OPEN_Booru"
SPARK_URL="https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js"

echo "==> OPEN Booru installer (Linux)"

need_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

detect_distro() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "${ID:-unknown}|${ID_LIKE:-}"
  else
    echo "unknown|"
  fi
}

install_nodejs() {
  local id like
  IFS='|' read -r id like <<<"$(detect_distro)"
  id="$(echo "$id" | tr '[:upper:]' '[:lower:]')"
  like="$(echo "$like" | tr '[:upper:]' '[:lower:]')"

  echo "==> Distro: id=$id"

  if have node && have npm; then
    echo "==> Node $(node -v), npm $(npm -v) already installed"
    return 0
  fi

  echo "==> Installing Node.js + npm..."

  # Arch
  if [[ "$id" == "arch" || "$id" == "manjaro" || "$id" == "endeavouros" || "$like" == *arch* ]]; then
    need_root pacman -Sy --needed --noconfirm nodejs npm git curl
    return 0
  fi

  # Fedora
  if [[ "$id" == "fedora" || "$id" == "rhel" || "$id" == "centos" || "$id" == "rocky" || "$id" == "almalinux" || "$like" == *fedora* || "$like" == *rhel* ]]; then
    need_root dnf install -y nodejs npm git curl
    return 0
  fi

  # Debian / Ubuntu
  if [[ "$id" == "debian" || "$id" == "ubuntu" || "$id" == "linuxmint" || "$id" == "pop" || "$like" == *debian* || "$like" == *ubuntu* ]]; then
    need_root apt-get update -y
    need_root apt-get install -y ca-certificates curl gnupg git
    if ! have node; then
      need_root mkdir -p /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | need_root gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
        | need_root tee /etc/apt/sources.list.d/nodesource.list >/dev/null
      need_root apt-get update -y
      need_root apt-get install -y nodejs
    else
      need_root apt-get install -y nodejs npm || need_root apt-get install -y nodejs
    fi
    return 0
  fi

  echo "ERROR: Unsupported distro ($id). Install Node.js >= 18 manually, then re-run from the project folder."
  exit 1
}

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
if [[ -f package.json ]] && grep -q '"name": "open-booru"' package.json 2>/dev/null; then
  ROOT="$(pwd)"
  echo "==> Using current directory: $ROOT"
elif [[ -f "$(dirname "$SCRIPT_PATH")/../package.json" ]]; then
  ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
  echo "==> Using repo next to script: $ROOT"
else
  install_nodejs
  if ! have git; then
    echo "ERROR: git is required to clone the repository"
    exit 1
  fi
  TARGET="${OPEN_BOORU_DIR:-$HOME/$REPO_NAME}"
  if [[ -d "$TARGET/.git" ]]; then
    echo "==> Updating existing clone: $TARGET"
    git -C "$TARGET" pull --ff-only || true
  else
    echo "==> Cloning $REPO_URL → $TARGET"
    git clone "$REPO_URL" "$TARGET"
  fi
  ROOT="$TARGET"
fi
cd "$ROOT"

install_nodejs

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [[ "${NODE_MAJOR:-0}" -lt 18 ]]; then
  echo "ERROR: Node.js >= 18 required (found $(node -v))"
  echo "       On Debian/Ubuntu, remove old node and re-run, or install from https://nodejs.org/"
  exit 1
fi
echo "==> Node $(node -v), npm $(npm -v)"

mkdir -p public/lib
SPARK="public/lib/spark-md5.min.js"
if [[ -s "$SPARK" ]]; then
  echo "==> spark-md5.min.js already present"
else
  echo "==> Downloading spark-md5.min.js..."
  if have curl; then
    curl -fsSL "$SPARK_URL" -o "$SPARK"
  elif have wget; then
    wget -qO "$SPARK" "$SPARK_URL"
  else
    echo "ERROR: need curl or wget"
    exit 1
  fi
  [[ -s "$SPARK" ]] || { echo "ERROR: failed to download spark-md5"; exit 1; }
fi

echo "==> npm install..."
npm install

WASM="node_modules/sql.js/dist/sql-wasm.wasm"
if [[ -f "$WASM" ]]; then
  SZ=$(wc -c < "$WASM")
  if [[ "$SZ" -lt 1000 ]]; then
    echo "WARN: sql-wasm.wasm looks corrupt ($SZ bytes). Try: npm install sql.js --force"
  else
    echo "==> sql-wasm.wasm OK ($SZ bytes)"
  fi
fi

echo ""
echo "==> Installation complete."
echo ""
echo "    Project path:  $ROOT"
echo "    Start server:  cd \"$ROOT\" && npm start"
echo "    Open browser:  http://localhost:3001"
echo ""
