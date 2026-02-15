import Redis from "ioredis";
import { randomUUID } from "crypto";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

// If SESSION_ID is not provided, runner generates one for self-registration.
const SESSION_ID = process.env.SESSION_ID?.trim() || randomUUID();

// Poll intervals
const IDLE_POLL_MS = 250;
const ACTIVE_POLL_MS = 500;
const SCAN_BATCH = 200;
const FINISH_LOCK_MS = 5_000;

// Shared Redis client for session/game state.
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

// Simple async delay helper.
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Register the session as idle and discoverable.
async function registerIdle(sessionId: string) {
  const now = Date.now().toString();
  await redis.hset(`session:${sessionId}`, {
    state: "IDLE",
    game_id: "",
    updated_at: now,
  });
  await redis.sadd("sessions:idle", sessionId);
}

// Finish a running game and return session + players to idle/lobby.
async function finishGame(sessionId: string, gameId: string) {
  const now = Date.now();

  // Pull players from game set.
  const playerIds = await redis.smembers(`game:${gameId}:players`);

  const pipe = redis.pipeline();

  // Mark game finished.
  pipe.hset(`game:${gameId}`, {
    state: "FINISHED",
    finished_at: now.toString(),
  });

  // Return players to lobby.
  for (const pid of playerIds) {
    pipe.hset(`player:${pid}`, {
      state: "IN_LOBBY",
      game_id: "",
      session_id: "",
      heartbeat_at: now.toString(),
    });
  }

  // Free session.
  pipe.hset(`session:${sessionId}`, {
    state: "IDLE",
    game_id: "",
    updated_at: now.toString(),
  });

  // Put session back into idle pool.
  pipe.sadd("sessions:idle", sessionId);

  await pipe.exec();

  // Publish match_ended so gateway can notify clients.
  await redis.publish(
    "events:match_ended",
    JSON.stringify({ gameId, sessionId, playerIds })
  );

  console.log(`MATCH_ENDED game=${gameId} session=${sessionId} players=${playerIds.length}`);
}

async function acquireFinishLock(gameId: string): Promise<boolean> {
  const res = await redis.set(`lock:finish:${gameId}`, "1", "PX", FINISH_LOCK_MS, "NX");
  return res === "OK";
}

async function processBusySessions() {
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "session:*", "COUNT", SCAN_BATCH);
    cursor = nextCursor;

    if (keys.length === 0) continue;

    const pipe = redis.pipeline();
    for (const key of keys) {
      pipe.hget(key, "state");
      pipe.hget(key, "game_id");
    }

    const results = await pipe.exec();
    if (!results) continue;

    for (let i = 0; i < keys.length; i++) {
      const sessionKey = keys[i];
      const state = results[i * 2]?.[1] as string | null;
      const gameId = results[i * 2 + 1]?.[1] as string | null;

      if (state !== "BUSY" || !gameId) continue;

      const sessionId = sessionKey.split(":")[1] ?? "";
      if (!sessionId) continue;

      const game = await redis.hgetall(`game:${gameId}`);
      const endAt = Number(game.end_at ?? "0");

      if (!endAt) {
        console.warn(`Game missing end_at; finishing now. game=${gameId}`);
        if (await acquireFinishLock(gameId)) {
          await finishGame(sessionId, gameId);
        }
        continue;
      }

      if (Date.now() >= endAt) {
        if (await acquireFinishLock(gameId)) {
          await finishGame(sessionId, gameId);
        }
      }
    }
  } while (cursor !== "0");
}

async function main() {
  console.log(`Session runner starting: session=${SESSION_ID} Redis=${REDIS_HOST}:${REDIS_PORT}`);

  // Always register as idle on startup - ensures we're in sessions:idle set
  await registerIdle(SESSION_ID);
  console.log(`Registered session as IDLE: ${SESSION_ID}`);

  while (true) {
    await processBusySessions();
    await sleep(ACTIVE_POLL_MS);
  }
}

// Exit on unexpected errors.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
