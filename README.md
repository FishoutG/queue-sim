# Queue-Sim

Distributed matchmaking queue simulation with auto-scaling session management.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Players   │────▶│   Gateway   │────▶│    Redis    │
│ (WebSocket) │     │  (WS Hub)   │     │   (State)   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    │                          │                          │
              ┌─────▼─────┐              ┌─────▼─────┐              ┌─────▼─────┐
              │ Matchmaker│              │  Session  │              │ Dashboard │
              │  (Queue)  │              │  (Games)  │              │   (UI)    │
              └───────────┘              └───────────┘              └───────────┘
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| Gateway | 3000 | WebSocket server for player connections |
| Matchmaker | - | Processes queue and creates games |
| Session | - | Runs game instances |
| Dashboard | 8080 | Web UI and REST API |
| Autoscaler | - | Manages Proxmox container scaling |

## Quick Start (Local Dev)

```bash
# Start Redis
docker compose up -d

# Terminal 1: Dashboard
npm run dev:dashboard

# Terminal 2: Gateway
npm run dev:gateway

# Terminal 3: Matchmaker
npm run dev:matchmaker

# Terminal 4: Session (create multiple)
SESSION_ID=session-1 npm run dev:session
```

## Production (Proxmox)

See [docs/proxmox-deployment.md](docs/proxmox-deployment.md) for full deployment guide.

```bash
# On each container, run the appropriate service:
npm run gateway      # Gateway container
npm run matchmaker   # Matchmaker containers
npm run session      # Session containers
npm run dashboard    # Dashboard container
npm run autoscaler   # Autoscaler container (manages session pool)
```

## Environment Variables

### All Services
- `REDIS_HOST` - Redis hostname (default: 127.0.0.1)
- `REDIS_PORT` - Redis port (default: 6379)

### Gateway
- `GATEWAY_PORT` - WebSocket port (default: 3000)

### Session
- `SESSION_ID` - Unique session identifier (required)

### Dashboard
- `DASHBOARD_PORT` - HTTP port (default: 8080)
- `PROXMOX_HOST` - Proxmox API host
- `PROXMOX_USER` - Proxmox API user
- `PROXMOX_TOKEN_ID` - Proxmox API token ID
- `PROXMOX_TOKEN_SECRET` - Proxmox API token secret

### Autoscaler
- `MIN_SESSIONS` - Minimum session containers (default: 10)
- `MAX_SESSIONS` - Maximum session containers (default: 300)
- `PLAYERS_PER_SESSION` - Players per session (default: 100)
- `SESSION_TEMPLATE_VMID` - Template container ID (default: 9001)
- `SESSION_VMID_START` - First session container ID (default: 200)
- `SESSION_VMID_END` - Last session container ID (default: 499)

## Scripts

```bash
npm run gateway          # Start gateway service
npm run matchmaker       # Start matchmaker service
npm run session          # Start session runner
npm run dashboard        # Start dashboard service
npm run autoscaler       # Start Proxmox autoscaler
npm run reaper           # Start stale player cleanup
npm run register-sessions # Register sessions in Redis
```

## License

MIT
