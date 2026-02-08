import Redis from "ioredis";
import { randomUUID } from "crypto";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

// If SESSION_ID not provided, runner generates one and registers itself.
const SESSION_ID = process.env.SESSION_ID?.trim() || randomUUID();

// Poll intervals
const IDLE_POLL_MS = 250;
const ACTIVE_POLL_MS = 500;

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function registerIdle(sessionId: string) {
  const now = Date.now().toString();
  await redis.hset(`session:${sessionId}`, {
    state: "IDLE",
    game_id: "",
    updated_at: now,
  });
  await redis.sadd("sessions:idle", sessionId);
}

async function finishGame(sessionId: string, gameId: string) {
  const now = Date.now();

  // Pull players from game set
  const playerIds = await redis.smembers(`game:${gameId}:players`);

  const pipe = redis.pipeline();

  // Mark game finished
  pipe.hset(`game:${gameId}`, {
    state: "FINISHED",
    finished_at: now.toString(),
  });

  // Return players to lobby
  for (const pid of playerIds) {
    pipe.hset(`player:${pid}`, {
      state: "IN_LOBBY",
      game_id: "",
      session_id: "",
      heartbeat_at: now.toString(),
    });
  }

  // Free session
  pipe.hset(`session:${sessionId}`, {
    state: "IDLE",
    game_id: "",
    updated_at: now.toString(),
  });

  // Put session back into idle pool
  pipe.sadd("sessions:idle", sessionId);

  await pipe.exec();

  // Publish match_ended so gateway can notify clients
  await redis.publish(
    "events:match_ended",
    JSON.stringify({ gameId, sessionId, playerIds })
  );

  console.log(`MATCH_ENDED game=${gameId} session=${sessionId} players=${playerIds.length}`);
}

async function main() {
  console.log(`Session runner starting: session=${SESSION_ID} Redis=${REDIS_HOST}:${REDIS_PORT}`);

  // Ensure we exist and are discoverable
  // IMPORTANT: Only register if the session doesn't exist yet.
  const existing = await redis.exists(`session:${SESSION_ID}`);
  if (!existing) {
    await registerIdle(SESSION_ID);
    console.log(`Registered new session as IDLE: ${SESSION_ID}`);
  } else {
    console.log(`Session already exists in Redis: ${SESSION_ID}`);
  }

  while (true) {
    const sessionKey = `session:${SESSION_ID}`;
    const session = await redis.hgetall(sessionKey);

    const state = session.state;
    const gameId = session.game_id;

    if (state !== "BUSY" || !gameId) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    // We're BUSY: find when game ends
    const game = await redis.hgetall(`game:${gameId}`);
    const endAt = Number(game.end_at ?? "0");

    if (!endAt) {
      // No end_at? Fail-safe: finish immediately to avoid stuck session.
      console.warn(`Game missing end_at; finishing now. game=${gameId}`);
      await finishGame(SESSION_ID, gameId);
      continue;
    }

    const now = Date.now();
    const waitMs = endAt - now;

    if (waitMs > 0) {
      console.log(`Game running game=${gameId} endsInMs=${waitMs}`);
      // Sleep until end (cap sleep to keep responsiveness if you later add draining/stop signals)
      const chunk = Math.min(waitMs, 5000);
      await sleep(chunk);
      continue;
    }

    // Time to end the game
    await finishGame(SESSION_ID, gameId);
    await sleep(ACTIVE_POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
