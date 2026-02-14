# Queue-Sim Proxmox Microservices Deployment

## Architecture Overview

| Service | Type | VMID Range | Count | Resources | Purpose |
|---------|------|------------|-------|-----------|---------|
| HAProxy | LXC | 100 | 1 | 1 CPU, 512MB | Load balancer, SSL termination |
| Redis | LXC | 101 | 1 | 2 CPU, 2GB | Shared state, pub/sub |
| Dashboard | LXC | 102 | 1 | 1 CPU, 512MB | Web UI, API |
| Autoscaler | LXC | 103 | 1 | 1 CPU, 256MB | Manages session pool |
| Gateway | LXC | 110 | 1-3 | 2 CPU, 1GB | WebSocket connections |
| Matchmaker | LXC | 120-129 | 3+ | 1 CPU, 512MB | Queue processing |
| Sessions | LXC | 200-499 | 10-300 | 1 CPU, 256MB | Game instances |

## Network Design

```
VLAN 10: Management (10.10.10.0/24)
  - HAProxy:     10.10.10.100
  - Redis:       10.10.10.101
  - Dashboard:   10.10.10.102
  - Autoscaler:  10.10.10.103
  - Gateway:     10.10.10.110
  - Matchmakers: 10.10.10.120-129
  - Sessions:    10.10.10.200-254, 10.10.11.0-254 (can span subnets)
```

## Step 1: Create Base Template

```bash
# On Proxmox host - Create Ubuntu/Debian LXC template
pveam update
pveam download local ubuntu-22.04-standard_22.04-1_amd64.tar.zst

# Create base container
pct create 9000 local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst \
  --hostname queue-sim-base \
  --memory 512 \
  --cores 1 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --storage local-lvm \
  --rootfs local-lvm:2

# Start and configure base
pct start 9000
pct enter 9000

# Inside container:
apt update && apt upgrade -y
apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2

# Clone and build
cd /opt
git clone https://github.com/FishoutG/queue-sim.git
cd queue-sim/queue-sim
npm install
npm run build  # if you add a build step

# Exit and convert to template
pct stop 9000
pct template 9000
```

## Step 2: Create Service Containers

### Redis (CT 101)
```bash
pct clone 9000 101 --hostname redis --full
pct set 101 --memory 2048 --cores 2 --net0 name=eth0,bridge=vmbr0,ip=10.10.10.101/24,gw=10.10.10.1
pct start 101
pct enter 101

# Install Redis
apt install -y redis-server
sed -i 's/bind 127.0.0.1/bind 0.0.0.0/' /etc/redis/redis.conf
sed -i 's/# requirepass foobared/requirepass your-secure-password/' /etc/redis/redis.conf
systemctl enable redis-server
systemctl restart redis-server
```

### Dashboard (CT 102)
```bash
pct clone 9000 102 --hostname dashboard --full
pct set 102 --memory 512 --cores 1 --net0 name=eth0,bridge=vmbr0,ip=10.10.10.102/24,gw=10.10.10.1
pct start 102
pct enter 102

# Configure
cat > /opt/queue-sim/queue-sim/.env << 'EOF'
REDIS_URL=redis://:your-secure-password@10.10.10.101:6379
DASHBOARD_PORT=8080
PROXMOX_HOST=10.10.10.10:8006
PROXMOX_USER=opnvdi@pam
PROXMOX_TOKEN_ID=UI2
PROXMOX_TOKEN_SECRET=your-token-secret
EOF

# Start with PM2
cd /opt/queue-sim/queue-sim
pm2 start src/dashboard/server.ts --name dashboard --interpreter ts-node
pm2 save
pm2 startup
```

### Gateway (CT 110)
```bash
pct clone 9000 110 --hostname gateway --full
pct set 110 --memory 1024 --cores 2 --net0 name=eth0,bridge=vmbr0,ip=10.10.10.110/24,gw=10.10.10.1
pct start 110
pct enter 110

cat > /opt/queue-sim/queue-sim/.env << 'EOF'
REDIS_URL=redis://:your-secure-password@10.10.10.101:6379
GATEWAY_PORT=3000
EOF

cd /opt/queue-sim/queue-sim
pm2 start src/gateway/server.ts --name gateway --interpreter ts-node
pm2 save
pm2 startup
```

### Matchmaker Pool (CT 120-122)
```bash
for i in 120 121 122; do
  pct clone 9000 $i --hostname matchmaker-$i --full
  pct set $i --memory 512 --cores 1 --net0 name=eth0,bridge=vmbr0,ip=10.10.10.$i/24,gw=10.10.10.1
  pct start $i
done

# Configure each matchmaker
for i in 120 121 122; do
  pct exec $i -- bash -c "cat > /opt/queue-sim/queue-sim/.env << 'EOF'
REDIS_URL=redis://:your-secure-password@10.10.10.101:6379
MATCHMAKER_ID=matchmaker-$i
EOF"
  pct exec $i -- bash -c "cd /opt/queue-sim/queue-sim && pm2 start src/matchmaker/worker.ts --name matchmaker --interpreter ts-node && pm2 save && pm2 startup"
done
```

### Autoscaler (CT 103)
```bash
pct clone 9000 103 --hostname autoscaler --full
pct set 103 --memory 256 --cores 1 --net0 name=eth0,bridge=vmbr0,ip=10.10.10.103/24,gw=10.10.10.1
pct start 103
pct enter 103

cat > /opt/queue-sim/queue-sim/.env << 'EOF'
REDIS_URL=redis://:your-secure-password@10.10.10.101:6379
PROXMOX_HOST=10.10.10.10:8006
PROXMOX_USER=opnvdi@pam
PROXMOX_TOKEN_ID=UI2
PROXMOX_TOKEN_SECRET=your-token-secret

# Autoscaler config
MIN_SESSIONS=10
MAX_SESSIONS=300
PLAYERS_PER_SESSION=100
SESSION_TEMPLATE_VMID=9001
SESSION_VMID_START=200
SESSION_VMID_END=499
EOF

cd /opt/queue-sim/queue-sim
pm2 start src/scripts/proxmox_autoscaler.ts --name autoscaler --interpreter ts-node
pm2 save
pm2 startup
```

## Step 3: Session Template (CT 9001)

```bash
pct clone 9000 9001 --hostname session-template --full
pct set 9001 --memory 256 --cores 1
pct start 9001
pct enter 9001

cat > /opt/queue-sim/queue-sim/.env << 'EOF'
REDIS_URL=redis://:your-secure-password@10.10.10.101:6379
# SESSION_ID will be set by autoscaler on clone
EOF

# Create startup script
cat > /opt/queue-sim/queue-sim/start-session.sh << 'EOF'
#!/bin/bash
cd /opt/queue-sim/queue-sim
export SESSION_ID=$(hostname | sed 's/session-//')
pm2 start src/session/runner.ts --name session --interpreter ts-node -- --id=$SESSION_ID
EOF
chmod +x /opt/queue-sim/queue-sim/start-session.sh

# Add to rc.local
echo '/opt/queue-sim/queue-sim/start-session.sh' >> /etc/rc.local

pct stop 9001
pct template 9001
```

## Step 4: HAProxy Load Balancer (CT 100)

```bash
pct clone 9000 100 --hostname haproxy --full
pct set 100 --memory 512 --cores 1 --net0 name=eth0,bridge=vmbr0,ip=10.10.10.100/24,gw=10.10.10.1
pct start 100
pct enter 100

apt install -y haproxy

cat > /etc/haproxy/haproxy.cfg << 'EOF'
global
    daemon
    maxconn 10000

defaults
    mode http
    timeout connect 5s
    timeout client 50s
    timeout server 50s

frontend http_front
    bind *:80
    bind *:443 ssl crt /etc/haproxy/certs/queue-sim.pem
    
    # Route WebSocket to gateway
    acl is_websocket hdr(Upgrade) -i websocket
    use_backend gateway_ws if is_websocket
    
    # Route dashboard
    default_backend dashboard

backend dashboard
    server dashboard 10.10.10.102:8080 check

backend gateway_ws
    balance roundrobin
    option httpchk GET /health
    server gateway1 10.10.10.110:3000 check
    # Add more gateways as needed
    # server gateway2 10.10.10.111:3000 check
EOF

systemctl enable haproxy
systemctl restart haproxy
```

## Scaling Math

For 30,000 players:
- Each session handles ~100 players
- Need 300 sessions minimum
- With 100 players per game, that's 300 concurrent games
- Buffer: 300-350 sessions for queue handling

## Autoscaler Logic

The autoscaler monitors:
1. `queue:ready` length in Redis
2. Active player count
3. Current session count

Scaling triggers:
- Scale UP when: `queue_length > (available_slots * 0.8)`
- Scale DOWN when: `active_sessions > (needed_sessions * 1.5)` for 5+ minutes

## Monitoring

Access your dashboard at: `https://10.10.10.100` (or your domain)

The Infrastructure tab will show all your Proxmox containers and their resource usage.

## Quick Commands

```bash
# Check all services
for ct in 101 102 103 110 120 121 122; do
  echo "=== CT $ct ==="
  pct exec $ct -- pm2 status
done

# View logs
pct exec 102 -- pm2 logs dashboard
pct exec 110 -- pm2 logs gateway
pct exec 103 -- pm2 logs autoscaler

# Scale matchmakers manually
pct clone 9000 123 --hostname matchmaker-123 --full
pct set 123 --memory 512 --cores 1 --net0 name=eth0,bridge=vmbr0,ip=10.10.10.123/24,gw=10.10.10.1
pct start 123

# Emergency: Stop all sessions
for ct in $(seq 200 499); do
  pct stop $ct 2>/dev/null
done
```
