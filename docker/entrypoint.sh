#!/usr/bin/env bash
# AVM all-in-one container entrypoint: starts incusd, then node daemon, then panel.
# Docker machines use the host Docker via the mounted /var/run/docker.sock.
# Env: ADMIN_USERNAME ADMIN_PASSWORD ADMIN_EMAIL PUBLIC_IP PANEL_PORT(8000) NODE_PORT(8090)
set -uo pipefail
log() { echo "❄ [avm] $*"; }
DATA=/data
mkdir -p "$DATA/panel" "$DATA/node"

# --- 1. checks -------------------------------------------------------------
if ! ip link add avmtest type dummy 2>/dev/null; then
  log "ERROR: this container is not privileged. Run it with --privileged (see docker-compose.yml)."; exit 1
fi
ip link del avmtest 2>/dev/null
[ -e /dev/kvm ] && log "KVM available (LXC + KVM)" || log "no /dev/kvm - LXC containers only"
[ -S /var/run/docker.sock ] && docker info >/dev/null 2>&1 && log "host Docker reachable - Docker machines enabled" || log "no /var/run/docker.sock mounted - Docker machines disabled"

# --- 2. cgroup v2: move ourselves into a child group so Incus can create its own (same trick as docker:dind)
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
fi
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
modprobe -a vhost_vsock vhost_net 2>/dev/null || true

# --- 3. start incusd (read env + command from the packaged systemd unit) ---
UNIT="$(ls /usr/lib/systemd/system/incus.service /lib/systemd/system/incus.service 2>/dev/null | head -n1)"
CMD="incusd --group incus-admin"
if [ -n "$UNIT" ]; then
  while IFS= read -r line; do
    case "$line" in Environment=*) v="${line#Environment=}"; v="${v%\"}"; v="${v#\"}"; export "$v" ;; esac
  done < "$UNIT"
  CMD="$(grep -m1 '^ExecStart=' "$UNIT" | sed 's/^ExecStart=//')"
fi
log "starting incusd"
$CMD >/var/log/incusd.log 2>&1 &
for _ in $(seq 1 60); do incus info >/dev/null 2>&1 && break; sleep 1; done
incus info >/dev/null 2>&1 || { log "ERROR: incusd did not start:"; tail -n 30 /var/log/incusd.log; exit 1; }
if [ -z "$(incus storage list --format csv 2>/dev/null)" ]; then
  log "first start - incus admin init --auto"
  incus admin init --auto || { log "ERROR: incus init failed"; exit 1; }
fi
incus network show incusbr0 >/dev/null 2>&1 || incus network create incusbr0
log "incus ready, bridge $(incus network get incusbr0 ipv4.address)"

# --- 4. config (token kept in the /data volume) -----------------------------
[ -s "$DATA/node-token" ] || node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$DATA/node-token"
export NT="$(cat "$DATA/node-token")" NP="${NODE_PORT:-8090}" PP="${PANEL_PORT:-8000}"
export PIP="${PUBLIC_IP:-$(curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}"
if [ ! -f "$DATA/panel/db.json" ] && [ -z "${ADMIN_PASSWORD:-}" ]; then
  export ADMIN_PASSWORD="$(node -e 'process.stdout.write(require("crypto").randomBytes(9).toString("base64url"))')"; GEN=1
fi
node -e '
const fs=require("fs"),e=process.env;
fs.writeFileSync("/app/node/config.json",JSON.stringify({port:+e.NP,host:"127.0.0.1",token:e.NT,bridge:"incusbr0",dockerNetwork:"avm-docker",dockerSubnet:e.DOCKER_SUBNET||"10.89.0.0/24",dataDir:"/data/node"},null,2));
fs.writeFileSync("/app/panel/config.json",JSON.stringify({port:+e.PP,host:"0.0.0.0",admin:{username:e.ADMIN_USERNAME||"admin",email:e.ADMIN_EMAIL||"",password:e.ADMIN_PASSWORD||""},localNode:{url:"http://127.0.0.1:"+e.NP,token:e.NT,publicIp:e.PIP}},null,2));'

# --- 5. node daemon, then panel --------------------------------------------
node /app/node/src/daemon.js &
NODE_PID=$!
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$NP/health" >/dev/null 2>&1 && break; sleep 1; done
log "node daemon online :$NP"
PANEL_DATA_DIR="$DATA/panel" node /app/panel/src/server.js &
PANEL_PID=$!
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PP/health" >/dev/null 2>&1 && break; sleep 1; done
log "panel online  http://$PIP:$PP"
[ "${GEN:-0}" = 1 ] && log "first login: ${ADMIN_USERNAME:-admin} / $ADMIN_PASSWORD   (change it in Account)"

stop_all() { log "stopping"; kill "$PANEL_PID" "$NODE_PID" 2>/dev/null; incus admin shutdown 2>/dev/null; exit 0; }
trap stop_all TERM INT
wait -n "$NODE_PID" "$PANEL_PID"
log "a process exited - stopping so Docker restarts the container"
stop_all
