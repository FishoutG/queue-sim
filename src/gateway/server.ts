import http from "http";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import { randomUUID } from "crypto";

type ClientMsg =
  | { type: "HELLO"; playerId?: string }
  | { type: "READY_UP" }
  | { type: "UNREADY" }
  | { type: "HEARTBEAT" }
  | { type: "LEAVE" };

type ServerMsg =
  | { type: "WELCOME"; playerId: string }
  | { type: "STATE"; state: "IN_LOBBY" | "READY" | "IN_GAME" }
  | { type: "MATCH_FOUND"; gameId: string; sessionId: string }
  | { type: "MATCH_ENDED"; gameId: string; sessionId: string }
  | { type: "ERROR"; code: string; message: string };

const PORT = Number(process.env.PORT ?? 3000);
const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

// Shared Redis client for player state and queues.
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

// Best-effort send: ignore transient socket failures.
function safeSend(ws: any, msg: ServerMsg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // ignore
  }
}

// Persist player state + heartbeat so other services can act on it.
// Only sets state if player doesn't already have a more "active" state (READY/IN_GAME).
async function setPlayerState(playerId: string, state: string, force = false) {
  const key = `player:${playerId}`;
  
  if (!force) {
    // Don't overwrite READY or IN_GAME with IN_LOBBY (prevents race with READY_UP).
    const existing = await redis.hget(key, "state");
    if (existing === "READY" || existing === "IN_GAME") {
      // Just update heartbeat, preserve state.
      await redis.hset(key, { heartbeat_at: Date.now().toString() });
      await redis.expire(key, 60 * 10);
      return;
    }
  }
  
  await redis.hset(key, {
    state,
    heartbeat_at: Date.now().toString(),
  });
  // Optional: expire player record if they disappear (e.g., 10 minutes)
  await redis.expire(key, 60 * 10);
}

async function main() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const sub = redis.duplicate();

  // Map connection -> playerId (connection-scoped identity).
  const wsToPlayer = new Map<any, string>();
  // Map playerId -> connection so we can notify by player.
  const playerToWs = new Map<string, any>();

  // Listen for match lifecycle events from other services.
  await sub.subscribe("events:match_found", "events:match_ended");
  sub.on("message", (channel, payload) => {
    try {
      const event = JSON.parse(payload);
      const { gameId, sessionId, playerIds } = event as {
        gameId: string;
        sessionId: string;
        playerIds: string[];
      };

      if (!Array.isArray(playerIds)) return;

      for (const playerId of playerIds) {
        const ws = playerToWs.get(playerId);
        if (!ws) continue;

        if (channel === "events:match_found") {
          safeSend(ws, { type: "MATCH_FOUND", gameId, sessionId });
          safeSend(ws, { type: "STATE", state: "IN_GAME" });
        } else if (channel === "events:match_ended") {
          safeSend(ws, { type: "MATCH_ENDED", gameId, sessionId });
          safeSend(ws, { type: "STATE", state: "IN_LOBBY" });
        }
      }
    } catch (e) {
      console.error("Event parse error:", e);
    }
  });

  wss.on("connection", async (ws) => {
    // Force a HELLO handshake within a short time.
    const helloTimeout = setTimeout(() => {
      safeSend(ws, {
        type: "ERROR",
        code: "NO_HELLO",
        message: "Send HELLO within 10 seconds of connecting.",
      });
      ws.close();
    }, 10000);

    // Serialize message processing per-connection to prevent race conditions.
    let messageQueue: Promise<void> = Promise.resolve();
    
    ws.on("message", (raw) => {
      messageQueue = messageQueue.then(async () => {
        let msg: ClientMsg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          safeSend(ws, { type: "ERROR", code: "BAD_JSON", message: "Invalid JSON." });
          return;
        }

        // HELLO establishes identity (client-supplied or generated).
        if (msg.type === "HELLO") {
          clearTimeout(helloTimeout);

          const playerId = msg.playerId?.trim() || randomUUID();
          wsToPlayer.set(ws, playerId);
          playerToWs.set(playerId, ws);

          await setPlayerState(playerId, "IN_LOBBY");

          safeSend(ws, { type: "WELCOME", playerId });
          safeSend(ws, { type: "STATE", state: "IN_LOBBY" });
          return;
        }

        const playerId = wsToPlayer.get(ws);
        if (!playerId) {
          safeSend(ws, {
            type: "ERROR",
            code: "NO_ID",
            message: "Send HELLO first.",
          });
          return;
        }

        switch (msg.type) {
          case "HEARTBEAT": {
            // Update heartbeat so other services can detect liveness.
            // Also ensure state exists (guards against race with HELLO's async setPlayerState).
            const existing = await redis.hget(`player:${playerId}`, "state");
            if (existing) {
              await redis.hset(`player:${playerId}`, { heartbeat_at: Date.now().toString() });
            } else {
              await redis.hset(`player:${playerId}`, { state: "IN_LOBBY", heartbeat_at: Date.now().toString() });
            }
            return;
          }

          case "READY_UP": {
            // Set state and enqueue into ready queue.
            await redis.hset(`player:${playerId}`, { state: "READY", heartbeat_at: Date.now().toString() });
            await redis.rpush("queue:ready", playerId);
            safeSend(ws, { type: "STATE", state: "READY" });
            return;
          }

          case "UNREADY": {
            // Simple v1: just set state back; removal from queue is lazy.
            await redis.hset(`player:${playerId}`, { state: "IN_LOBBY", heartbeat_at: Date.now().toString() });
            safeSend(ws, { type: "STATE", state: "IN_LOBBY" });
            return;
          }

          case "LEAVE": {
            // Mark as lobby and close the socket.
            await redis.hset(`player:${playerId}`, { state: "IN_LOBBY" });
            ws.close();
            return;
          }

          default:
            safeSend(ws, { type: "ERROR", code: "UNKNOWN", message: "Unknown message type." });
        }
      }).catch((err) => {
        console.error("Message handler error:", err);
      });
    });

    ws.on("close", async () => {
      clearTimeout(helloTimeout);
      const playerId = wsToPlayer.get(ws);
      wsToPlayer.delete(ws);
      if (playerId) playerToWs.delete(playerId);

      // v1: mark as lobby (or disconnected). TTL cleanup is handled elsewhere.
      if (playerId) {
        await redis.hset(`player:${playerId}`, { state: "IN_LOBBY" });
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`Gateway listening on ws://0.0.0.0:${PORT}`);
    console.log(`Redis at ${REDIS_HOST}:${REDIS_PORT}`);
  });
}

// Crash fast so orchestration can restart us.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
