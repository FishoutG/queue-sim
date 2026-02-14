import Redis from "ioredis";
import { randomUUID } from "crypto";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const MATCH_MIN_SECONDS = Number(process.env.MATCH_MIN_SECONDS ?? 30);
const MATCH_MAX_SECONDS = Number(process.env.MATCH_MAX_SECONDS ?? 300);

const BATCH_SIZE = 100;
const MAX_PULL = 400; // how many queue entries we are willing to inspect to find 100 valid READY players
const SLEEP_MS_IDLE = 250;
const SLEEP_MS_NO_SESSION = 500;

// Shared Redis client for queues and state.
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

// Simple async delay helper.
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Clamp a value to a range.
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// Choose a randomized match duration with a triangular distribution.
function pickMatchDurationMs(): number {
  const minSec = Math.min(MATCH_MIN_SECONDS, MATCH_MAX_SECONDS);
  const maxSec = Math.max(MATCH_MIN_SECONDS, MATCH_MAX_SECONDS);
  const span = Math.max(0, maxSec - minSec);

  // Triangular distribution centered at the midpoint for more realistic durations.
  const u = Math.random();
  const v = Math.random();
  const triangular01 = (u + v) / 2;
  const seconds = minSec + triangular01 * span;

  return Math.round(clamp(seconds, minSec, maxSec) * 1000);
}

async function reserveIdleSession(): Promise<string | null> {
  // Take one idle session ID (1 session = 1 match).
  const sessionId = await redis.spop("sessions:idle");
  if (!sessionId) return null;

  await redis.hset(`session:${sessionId}`, {
    state: "RESERVED",
    updated_at: Date.now().toString(),
  });

  return sessionId;
}

async function releaseSessionBackToIdle(sessionId: string) {
  // Return the session to the idle pool after a failed match attempt.
  await redis.hset(`session:${sessionId}`, {
    state: "IDLE",
    game_id: "",
    updated_at: Date.now().toString(),
  });
  await redis.sadd("sessions:idle", sessionId);
}

async function pickReadyPlayers(): Promise<string[]> {
  const picked: string[] = [];
  const toReturn: string[] = []; // READY players we popped but won't use
  let inspected = 0;

  while (picked.length < BATCH_SIZE && inspected < MAX_PULL) {
    const need = BATCH_SIZE - picked.length;
    // Pull more to compensate for stale entries in the queue.
    const toPull = Math.min(need * 2, MAX_PULL - inspected);
    if (toPull <= 0) break;

    // Pop candidate IDs from the queue.
    const candidates: string[] = [];
    for (let i = 0; i < toPull; i++) {
      const id = await redis.lpop("queue:ready");
      if (!id) break;
      candidates.push(id);
    }

    if (candidates.length === 0) break;
    inspected += candidates.length;

    // Check which are still READY (lazy cleanup).
    const pipe = redis.pipeline();
    for (const id of candidates) pipe.hget(`player:${id}`, "state");
    const states = await pipe.exec();

    for (let i = 0; i < candidates.length; i++) {
      const playerId = candidates[i];
      const state = states?.[i]?.[1] as string | null;

      if (state === "READY") {
        if (picked.length < BATCH_SIZE) {
          picked.push(playerId);
        } else {
          // Already have enough, save to return to queue
          toReturn.push(playerId);
        }
      }
      // else: stale entry - ignore (player UNREADY/disconnected/etc).
    }
  }

  // Put back any READY players we didn't pick
  if (toReturn.length > 0) {
    await redis.rpush("queue:ready", ...toReturn);
  }

  // If we didn't get enough, put the valid ones back so we don't lose them.
  if (picked.length > 0 && picked.length < BATCH_SIZE) {
    await redis.rpush("queue:ready", ...picked);
    return [];
  }

  return picked;
}


async function createMatch(sessionId: string, playerIds: string[]) {
  const gameId = randomUUID();
  const now = Date.now();
  const durationMs = pickMatchDurationMs();
  const endAt = now + durationMs;

  // Create game records + move players to IN_GAME.
  const pipe = redis.pipeline();

  pipe.hset(`game:${gameId}`, {
    session_id: sessionId,
    state: "RUNNING",
    started_at: now.toString(),
    end_at: endAt.toString(),
  });

  for (const pid of playerIds) {
    pipe.sadd(`game:${gameId}:players`, pid);
    pipe.hset(`player:${pid}`, {
      state: "IN_GAME",
      game_id: gameId,
      session_id: sessionId,
      heartbeat_at: now.toString(),
    });
  }

  // Mark session busy (1 session = 1 match).
  pipe.hset(`session:${sessionId}`, {
    state: "BUSY",
    game_id: gameId,
    updated_at: now.toString(),
  });

  await pipe.exec();

  // Publish event so Gateway can notify connected sockets.
  await redis.publish(
    "events:match_found",
    JSON.stringify({ gameId, sessionId, playerIds })
  );

  console.log(
    `MATCH_FOUND game=${gameId} session=${sessionId} players=${playerIds.length} endAt=${new Date(
      endAt
    ).toISOString()}`
  );
}

// Distributed lock to prevent multiple matchmakers from racing
const MATCHMAKER_LOCK_KEY = "lock:matchmaker";
const MATCHMAKER_LOCK_TTL_MS = 5000;

async function acquireMatchmakerLock(): Promise<boolean> {
  const result = await redis.set(MATCHMAKER_LOCK_KEY, process.pid.toString(), "PX", MATCHMAKER_LOCK_TTL_MS, "NX");
  return result === "OK";
}

async function releaseMatchmakerLock(): Promise<void> {
  await redis.del(MATCHMAKER_LOCK_KEY);
}

async function main() {
  console.log(`Matchmaker starting. Redis at ${REDIS_HOST}:${REDIS_PORT}`);

  while (true) {
    // Acquire lock before processing to prevent race with other matchmakers
    if (!await acquireMatchmakerLock()) {
      await sleep(SLEEP_MS_IDLE);
      continue;
    }

    try {
      const readyLen = await redis.llen("queue:ready");
      if (readyLen < BATCH_SIZE) {
        await sleep(SLEEP_MS_IDLE);
        continue;
      }

      const idleSessions = await redis.scard("sessions:idle");
      const targetMatches = Math.min(Math.floor(readyLen / BATCH_SIZE), idleSessions);

      if (targetMatches <= 0) {
        await sleep(SLEEP_MS_NO_SESSION);
        continue;
      }

      let createdAny = false;

      for (let i = 0; i < targetMatches; i++) {
        const sessionId = await reserveIdleSession();
        if (!sessionId) break;

        try {
          const players = await pickReadyPlayers();
          if (players.length !== BATCH_SIZE) {
            // Not enough valid READY players after cleanup.
            await releaseSessionBackToIdle(sessionId);
            break;
          }

          await createMatch(sessionId, players);
          createdAny = true;
        } catch (e) {
          console.error("Matchmaker error:", e);
          // Avoid leaking reserved sessions.
          await releaseSessionBackToIdle(sessionId);
          await sleep(250);
          break;
        }
      }

      if (!createdAny) {
        await sleep(SLEEP_MS_IDLE);
      }
    } finally {
      await releaseMatchmakerLock();
    }
  }
}

// Exit on unexpected errors.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
