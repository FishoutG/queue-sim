# Queue-Sim Dashboard Plan

## Overview
Real-time web dashboard showing matchmaking system state with extensibility for infrastructure monitoring (Proxmox).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web Dashboard                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ Players  │  │  Games   │  │ Sessions │  │ Infrastructure   │ │
│  │  Panel   │  │  Panel   │  │  Panel   │  │ (Proxmox Future) │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Dashboard API Server                          │
│  GET /api/stats          - Aggregated counts                     │
│  GET /api/players        - Player list with states               │
│  GET /api/games          - Active games                          │
│  GET /api/sessions       - Session status                        │
│  GET /api/infra          - Proxmox stats (future)                │
│  WS  /ws                 - Real-time updates                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Redis                                   │
│  player:* │ game:* │ session:* │ queue:ready │ events:*         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Pages & Components

### 1. Main Dashboard (`/`)
- **Summary Cards**: Total players, active games, idle/busy sessions, queue depth
- **Auto-refresh**: WebSocket for real-time updates

### 2. Players Panel
| Column     | Source                        |
|------------|-------------------------------|
| Player ID  | `player:{id}`                 |
| State      | `player:{id}.state`           |
| Game ID    | `player:{id}.game_id`         |
| Session    | `player:{id}.session_id`      |
| Last Seen  | `player:{id}.heartbeat_at`    |

**Filters**: IN_LOBBY, READY, IN_GAME, DISCONNECTED

### 3. Games Panel
| Column      | Source                      |
|-------------|------------------------------|
| Game ID     | `game:{id}`                  |
| Session     | `game:{id}.session_id`       |
| State       | `game:{id}.state`            |
| Players     | `game:{id}:players` (SCARD)  |
| Started     | `game:{id}.started_at`       |
| Ends At     | `game:{id}.end_at`           |
| Time Left   | Computed from `end_at`       |

### 4. Sessions Panel
| Column      | Source                       |
|-------------|------------------------------|
| Session ID  | `session:{id}`               |
| State       | IDLE / BUSY                  |
| Game ID     | If BUSY                      |
| Updated     | `session:{id}.updated_at`    |

### 5. Infrastructure Panel (Future - Proxmox)
| Metric        | Source                      |
|---------------|------------------------------|
| Node Name     | Proxmox API                  |
| CPU %         | `/nodes/{node}/status`       |
| Memory %      | `/nodes/{node}/status`       |
| VMs Running   | `/nodes/{node}/qemu`         |
| Containers    | `/nodes/{node}/lxc`          |

---

## Tech Stack

### Backend
- **Express.js** - REST API
- **ws** - WebSocket for real-time
- **ioredis** - Redis queries + pub/sub

### Frontend
- **Vanilla HTML/CSS/JS** (lightweight, no build step)
- **Alternatives**: React, Vue, or htmx for more interactivity

### Styling
- **CSS Variables** for theming
- Dark mode by default (matches typical ops dashboards)

---

## API Endpoints

### `GET /api/stats`
```json
{
  "players": {
    "total": 1000,
    "inLobby": 400,
    "ready": 200,
    "inGame": 400
  },
  "games": {
    "running": 4,
    "finished": 12
  },
  "sessions": {
    "total": 41,
    "idle": 37,
    "busy": 4
  },
  "queue": {
    "ready": 200
  }
}
```

### `GET /api/players?state=IN_GAME&limit=100`
```json
{
  "players": [
    {
      "id": "abc-123",
      "state": "IN_GAME",
      "gameId": "game-456",
      "sessionId": "sess-789",
      "heartbeatAt": 1707900000000
    }
  ],
  "total": 400
}
```

### `GET /api/games?state=RUNNING`
```json
{
  "games": [
    {
      "id": "game-456",
      "sessionId": "sess-789",
      "state": "RUNNING",
      "playerCount": 100,
      "startedAt": 1707900000000,
      "endAt": 1707900010000,
      "timeLeftMs": 5000
    }
  ]
}
```

### `GET /api/sessions`
```json
{
  "sessions": [
    {
      "id": "sess-789",
      "state": "BUSY",
      "gameId": "game-456",
      "updatedAt": 1707900000000
    }
  ]
}
```

### `WS /ws` (Real-time events)
```json
{ "type": "STATS_UPDATE", "data": { ... } }
{ "type": "MATCH_FOUND", "gameId": "...", "sessionId": "..." }
{ "type": "MATCH_ENDED", "gameId": "...", "sessionId": "..." }
```

---

## File Structure

```
src/
  dashboard/
    server.ts          # Express + WebSocket server
    routes/
      stats.ts         # GET /api/stats
      players.ts       # GET /api/players
      games.ts         # GET /api/games  
      sessions.ts      # GET /api/sessions
      infra.ts         # GET /api/infra (Proxmox - future)
    services/
      redis.ts         # Redis query helpers
      proxmox.ts       # Proxmox API client (future)
    public/
      index.html       # Dashboard UI
      style.css        # Styling
      app.js           # Frontend logic
```

---

## Proxmox Integration (Future)

### Configuration
```env
PROXMOX_HOST=https://proxmox.local:8006
PROXMOX_USER=api@pam
PROXMOX_TOKEN_ID=dashboard
PROXMOX_TOKEN_SECRET=xxx
```

### API Wrapper
```typescript
// src/dashboard/services/proxmox.ts
interface ProxmoxNode {
  node: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
}

async function getNodes(): Promise<ProxmoxNode[]> { ... }
async function getVMs(node: string): Promise<VM[]> { ... }
async function getContainers(node: string): Promise<Container[]> { ... }
```

---

## Implementation Phases

### Phase 1: Core Dashboard ✓
- [ ] Dashboard API server with stats endpoint
- [ ] Players/Games/Sessions REST endpoints
- [ ] Basic HTML/CSS/JS frontend
- [ ] WebSocket real-time updates

### Phase 2: Enhanced UI
- [ ] Filtering and pagination
- [ ] Sortable tables
- [ ] Auto-refresh toggle
- [ ] Dark/light theme

### Phase 3: Proxmox Integration
- [ ] Proxmox API client
- [ ] Node status cards
- [ ] VM/Container list
- [ ] Resource graphs

---

## Quick Start (After Implementation)

```bash
# Start dashboard on port 8080
npm run dashboard

# Or with custom port
PORT=8080 npm run dashboard
```

Then open http://localhost:8080
