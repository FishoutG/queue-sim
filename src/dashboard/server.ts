/**
 * Dashboard API Server
 * 
 * Provides REST endpoints and WebSocket for real-time monitoring of:
 * - Players (by state: IN_LOBBY, READY, IN_GAME)
 * - Games (running/finished)
 * - Sessions (idle/busy)
 * - Infrastructure (Proxmox - future)
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";
import path from "path";
import { getProxmoxStats } from "./services/proxmox";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.DASHBOARD_PORT ?? 8080);
const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

// ─────────────────────────────────────────────────────────────────────────────
// Redis Connections
// ─────────────────────────────────────────────────────────────────────────────

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
const sub = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

// ─────────────────────────────────────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────────────────────
// API: Stats Overview
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/stats", async (_req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    console.error("Error fetching stats:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

async function getStats() {
  // Count players by state
  const playerKeys = await redis.keys("player:*");
  const playerCounts = { total: 0, inLobby: 0, ready: 0, inGame: 0, disconnected: 0 };

  if (playerKeys.length > 0) {
    const pipe = redis.pipeline();
    for (const key of playerKeys) pipe.hget(key, "state");
    const results = await pipe.exec();

    for (const [err, state] of results ?? []) {
      if (err) continue;
      playerCounts.total++;
      switch (state) {
        case "IN_LOBBY": playerCounts.inLobby++; break;
        case "READY": playerCounts.ready++; break;
        case "IN_GAME": playerCounts.inGame++; break;
        case "DISCONNECTED": playerCounts.disconnected++; break;
      }
    }
  }

  // Count games by state
  const gameKeys = await redis.keys("game:*");
  const gameCounts = { running: 0, finished: 0 };
  const gameKeysFiltered = gameKeys.filter(k => !k.includes(":players"));

  if (gameKeysFiltered.length > 0) {
    const pipe = redis.pipeline();
    for (const key of gameKeysFiltered) pipe.hget(key, "state");
    const results = await pipe.exec();

    for (const [err, state] of results ?? []) {
      if (err) continue;
      if (state === "RUNNING") gameCounts.running++;
      else if (state === "FINISHED") gameCounts.finished++;
    }
  }

  // Count sessions by state
  const sessionKeys = await redis.keys("session:*");
  const sessionCounts = { total: sessionKeys.length, idle: 0, busy: 0 };

  if (sessionKeys.length > 0) {
    const pipe = redis.pipeline();
    for (const key of sessionKeys) pipe.hget(key, "state");
    const results = await pipe.exec();

    for (const [err, state] of results ?? []) {
      if (err) continue;
      if (state === "IDLE") sessionCounts.idle++;
      else if (state === "BUSY") sessionCounts.busy++;
    }
  }

  // Queue depth
  const queueReady = await redis.llen("queue:ready");

  return {
    players: playerCounts,
    games: gameCounts,
    sessions: sessionCounts,
    queue: { ready: queueReady },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API: Player Controls
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";

// Spawn new players (creates player records and optionally readies them)
app.post("/api/players/spawn", async (req, res) => {
  try {
    const count = Number(req.body.count ?? 10);
    const readyUp = req.body.readyUp === true;
    const now = Date.now();
    const created: string[] = [];

    const pipe = redis.pipeline();
    for (let i = 0; i < count; i++) {
      const playerId = randomUUID();
      const state = readyUp ? "READY" : "IN_LOBBY";
      pipe.hset(`player:${playerId}`, {
        state,
        heartbeat_at: now.toString(),
      });
      pipe.expire(`player:${playerId}`, 60 * 10);
      if (readyUp) {
        pipe.rpush("queue:ready", playerId);
      }
      created.push(playerId);
    }
    await pipe.exec();

    res.json({ success: true, count: created.length, readyUp });
  } catch (err) {
    console.error("Error spawning players:", err);
    res.status(500).json({ error: "Failed to spawn players" });
  }
});

// Ready up all players in lobby
app.post("/api/players/ready-all", async (req, res) => {
  try {
    const playerKeys = await redis.keys("player:*");
    let readied = 0;
    const now = Date.now();

    if (playerKeys.length > 0) {
      const pipe = redis.pipeline();
      for (const key of playerKeys) pipe.hget(key, "state");
      const results = await pipe.exec();

      const updatePipe = redis.pipeline();
      for (let i = 0; i < playerKeys.length; i++) {
        const [err, state] = results?.[i] ?? [null, null];
        if (err || state !== "IN_LOBBY") continue;

        const playerId = playerKeys[i].split(":")[1];
        updatePipe.hset(playerKeys[i], { state: "READY", heartbeat_at: now.toString() });
        updatePipe.rpush("queue:ready", playerId);
        readied++;
      }
      await updatePipe.exec();
    }

    res.json({ success: true, readied });
  } catch (err) {
    console.error("Error readying players:", err);
    res.status(500).json({ error: "Failed to ready players" });
  }
});

// Ready up a specific player
app.post("/api/players/:id/ready", async (req, res) => {
  try {
    const playerId = req.params.id;
    const key = `player:${playerId}`;
    const state = await redis.hget(key, "state");

    if (!state) {
      return res.status(404).json({ error: "Player not found" });
    }

    if (state !== "IN_LOBBY") {
      return res.status(400).json({ error: `Player is ${state}, not IN_LOBBY` });
    }

    await redis.hset(key, { state: "READY", heartbeat_at: Date.now().toString() });
    await redis.rpush("queue:ready", playerId);

    res.json({ success: true, playerId });
  } catch (err) {
    console.error("Error readying player:", err);
    res.status(500).json({ error: "Failed to ready player" });
  }
});

// Clear all players
app.post("/api/players/clear", async (req, res) => {
  try {
    const playerKeys = await redis.keys("player:*");
    if (playerKeys.length > 0) {
      await redis.del(...playerKeys);
    }
    await redis.del("queue:ready");
    res.json({ success: true, cleared: playerKeys.length });
  } catch (err) {
    console.error("Error clearing players:", err);
    res.status(500).json({ error: "Failed to clear players" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: Players List
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/players", async (req, res) => {
  try {
    const stateFilter = req.query.state as string | undefined;
    const limit = Number(req.query.limit ?? 100);

    const playerKeys = await redis.keys("player:*");
    const players: any[] = [];

    if (playerKeys.length > 0) {
      const pipe = redis.pipeline();
      for (const key of playerKeys) pipe.hgetall(key);
      const results = await pipe.exec();

      for (let i = 0; i < playerKeys.length; i++) {
        const [err, data] = results?.[i] ?? [null, null];
        if (err || !data) continue;

        const player = data as Record<string, string>;
        if (stateFilter && player.state !== stateFilter) continue;

        players.push({
          id: playerKeys[i].split(":")[1],
          state: player.state,
          gameId: player.game_id || null,
          sessionId: player.session_id || null,
          heartbeatAt: Number(player.heartbeat_at) || null,
        });

        if (players.length >= limit) break;
      }
    }

    res.json({ players, total: players.length });
  } catch (err) {
    console.error("Error fetching players:", err);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: Games List
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/games", async (req, res) => {
  try {
    const stateFilter = req.query.state as string | undefined;
    const gameKeys = await redis.keys("game:*");
    const games: any[] = [];

    const gameKeysFiltered = gameKeys.filter(k => !k.includes(":players"));

    for (const key of gameKeysFiltered) {
      const data = await redis.hgetall(key);
      if (!data || Object.keys(data).length === 0) continue;
      if (stateFilter && data.state !== stateFilter) continue;

      const gameId = key.split(":")[1];
      const playerCount = await redis.scard(`game:${gameId}:players`);
      const now = Date.now();
      const endAt = Number(data.end_at) || 0;

      games.push({
        id: gameId,
        sessionId: data.session_id,
        state: data.state,
        playerCount,
        startedAt: Number(data.started_at) || null,
        endAt: endAt || null,
        timeLeftMs: data.state === "RUNNING" ? Math.max(0, endAt - now) : 0,
      });
    }

    // Sort by started_at descending (newest first)
    games.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

    res.json({ games });
  } catch (err) {
    console.error("Error fetching games:", err);
    res.status(500).json({ error: "Failed to fetch games" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: Sessions List
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/sessions", async (req, res) => {
  try {
    const stateFilter = req.query.state as string | undefined;
    const sessionKeys = await redis.keys("session:*");
    const sessions: any[] = [];

    if (sessionKeys.length > 0) {
      const pipe = redis.pipeline();
      for (const key of sessionKeys) pipe.hgetall(key);
      const results = await pipe.exec();

      for (let i = 0; i < sessionKeys.length; i++) {
        const [err, data] = results?.[i] ?? [null, null];
        if (err || !data) continue;

        const session = data as Record<string, string>;
        if (stateFilter && session.state !== stateFilter) continue;

        sessions.push({
          id: sessionKeys[i].split(":")[1],
          state: session.state,
          gameId: session.game_id || null,
          updatedAt: Number(session.updated_at) || null,
        });
      }
    }

    res.json({ sessions });
  } catch (err) {
    console.error("Error fetching sessions:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: Infrastructure (Proxmox - Future)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/infra", async (_req, res) => {
  try {
    const stats = await getProxmoxStats();
    res.json(stats);
  } catch (err) {
    console.error("Error fetching Proxmox stats:", err);
    res.json({
      enabled: false,
      error: String(err),
      nodes: [],
      vms: [],
      containers: [],
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket Server
// ─────────────────────────────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Track connected clients
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`Dashboard client connected. Total: ${clients.size}`);

  // Send initial stats on connect
  getStats().then((stats) => {
    ws.send(JSON.stringify({ type: "STATS_UPDATE", data: stats }));
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`Dashboard client disconnected. Total: ${clients.size}`);
  });
});

// Broadcast to all connected clients
function broadcast(message: object) {
  const json = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis Pub/Sub for Real-time Events
// ─────────────────────────────────────────────────────────────────────────────

sub.subscribe("events:match_found", "events:match_ended");

sub.on("message", async (channel, message) => {
  try {
    const data = JSON.parse(message);

    if (channel === "events:match_found") {
      broadcast({ type: "MATCH_FOUND", ...data });
    } else if (channel === "events:match_ended") {
      broadcast({ type: "MATCH_ENDED", ...data });
    }

    // Also send updated stats
    const stats = await getStats();
    broadcast({ type: "STATS_UPDATE", data: stats });
  } catch (err) {
    console.error("Error processing pub/sub message:", err);
  }
});

// Periodic stats broadcast (every 2 seconds)
setInterval(async () => {
  if (clients.size > 0) {
    try {
      const stats = await getStats();
      broadcast({ type: "STATS_UPDATE", data: stats });
    } catch (err) {
      console.error("Error broadcasting stats:", err);
    }
  }
}, 2000);

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Dashboard server running at http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`Redis: ${REDIS_HOST}:${REDIS_PORT}`);
});
