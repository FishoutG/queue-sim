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
  | { type: "ERROR"; code: string; message: string };

const PORT = Number(process.env.PORT ?? 3000);
const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

function safeSend(ws: any, msg: ServerMsg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // ignore
  }
}

async function setPlayerState(playerId: string, state: string) {
  const key = `player:${playerId}`;
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

  // Map connection -> playerId (connection-scoped)
  const wsToPlayer = new Map<any, string>();

  wss.on("connection", async (ws) => {
    // Force a HELLO handshake within a short time
    const helloTimeout = setTimeout(() => {
      safeSend(ws, {
        type: "ERROR",
        code: "NO_HELLO",
        message: "Send HELLO within 10 seconds of connecting.",
      });
      ws.close();
    }, 10000);

    ws.on("message", async (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        safeSend(ws, { type: "ERROR", code: "BAD_JSON", message: "Invalid JSON." });
        return;
      }

      // HELLO = establish identity
      if (msg.type === "HELLO") {
        clearTimeout(helloTimeout);

        const playerId = msg.playerId?.trim() || randomUUID();
        wsToPlayer.set(ws, playerId);

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
          await redis.hset(`player:${playerId}`, { heartbeat_at: Date.now().toString() });
          return;
        }

        case "READY_UP": {
          // Set state and enqueue into ready queue
          await redis.hset(`player:${playerId}`, { state: "READY", heartbeat_at: Date.now().toString() });
          await redis.rpush("queue:ready", playerId);
          safeSend(ws, { type: "STATE", state: "READY" });
          return;
        }

        case "UNREADY": {
          // Simple v1: just set state back; removal from queue can be handled later (lazy cleanup)
          await redis.hset(`player:${playerId}`, { state: "IN_LOBBY", heartbeat_at: Date.now().toString() });
          safeSend(ws, { type: "STATE", state: "IN_LOBBY" });
          return;
        }

        case "LEAVE": {
          await redis.hset(`player:${playerId}`, { state: "IN_LOBBY" });
          ws.close();
          return;
        }

        default:
          safeSend(ws, { type: "ERROR", code: "UNKNOWN", message: "Unknown message type." });
      }
    });

    ws.on("close", async () => {
      clearTimeout(helloTimeout);
      const playerId = wsToPlayer.get(ws);
      wsToPlayer.delete(ws);

      // v1: mark as lobby (or disconnected). We'll refine later with a reaper/TTL strategy.
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
