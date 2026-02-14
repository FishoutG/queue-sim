/**
 * Session Auto-Scaler
 * 
 * Automatically scales the number of sessions based on demand:
 * - Monitors queue depth (players waiting)
 * - Monitors idle/busy session counts
 * - Creates new sessions when demand exceeds capacity
 * - Removes excess idle sessions when demand drops
 * 
 * Config via environment variables:
 *   MIN_SESSIONS     - Minimum sessions to maintain (default: 10)
 *   MAX_SESSIONS     - Maximum sessions allowed (default: 200)
 *   PLAYERS_PER_GAME - Players required per game (default: 100)
 *   POLL_INTERVAL_MS - How often to check and scale (default: 1000)
 *   SCALE_UP_BUFFER  - Extra sessions to create beyond immediate need (default: 5)
 */

import Redis from "ioredis";
import { randomUUID } from "crypto";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

const MIN_SESSIONS = Number(process.env.MIN_SESSIONS ?? 10);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 200);
const PLAYERS_PER_GAME = Number(process.env.PLAYERS_PER_GAME ?? 100);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1000);
const SCALE_UP_BUFFER = Number(process.env.SCALE_UP_BUFFER ?? 5);

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getStats() {
  const [queueDepth, idleCount, allSessionKeys] = await Promise.all([
    redis.llen("queue:ready"),
    redis.scard("sessions:idle"),
    redis.keys("session:*"),
  ]);

  // Count busy sessions
  let busyCount = 0;
  if (allSessionKeys.length > 0) {
    const pipe = redis.pipeline();
    for (const key of allSessionKeys) {
      pipe.hget(key, "state");
    }
    const states = await pipe.exec();
    for (const [, state] of states ?? []) {
      if (state === "BUSY" || state === "RESERVED") {
        busyCount++;
      }
    }
  }

  const totalSessions = allSessionKeys.length;

  return { queueDepth, idleCount, busyCount, totalSessions };
}

async function createSessions(count: number): Promise<string[]> {
  const created: string[] = [];
  const pipe = redis.pipeline();
  const now = Date.now().toString();

  for (let i = 0; i < count; i++) {
    const sessionId = randomUUID();
    pipe.hset(`session:${sessionId}`, {
      state: "IDLE",
      game_id: "",
      updated_at: now,
    });
    pipe.sadd("sessions:idle", sessionId);
    created.push(sessionId);
  }

  await pipe.exec();
  return created;
}

async function removeIdleSessions(count: number): Promise<number> {
  let removed = 0;

  for (let i = 0; i < count; i++) {
    const sessionId = await redis.spop("sessions:idle");
    if (!sessionId) break;

    // Only delete if still idle (avoid race with matchmaker)
    const state = await redis.hget(`session:${sessionId}`, "state");
    if (state === "IDLE") {
      await redis.del(`session:${sessionId}`);
      removed++;
    } else {
      // Put it back if it's no longer idle
      await redis.sadd("sessions:idle", sessionId);
    }
  }

  return removed;
}

async function scaleLoop() {
  console.log(`Session auto-scaler started`);
  console.log(`  MIN_SESSIONS: ${MIN_SESSIONS}`);
  console.log(`  MAX_SESSIONS: ${MAX_SESSIONS}`);
  console.log(`  PLAYERS_PER_GAME: ${PLAYERS_PER_GAME}`);
  console.log(`  POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);

  // Ensure minimum sessions on startup
  const initialStats = await getStats();
  if (initialStats.totalSessions < MIN_SESSIONS) {
    const toCreate = MIN_SESSIONS - initialStats.totalSessions;
    await createSessions(toCreate);
    console.log(`Created ${toCreate} initial sessions to meet minimum`);
  }

  while (true) {
    try {
      const stats = await getStats();
      const { queueDepth, idleCount, busyCount, totalSessions } = stats;

      // Calculate how many games could be formed from the queue
      const potentialGames = Math.ceil(queueDepth / PLAYERS_PER_GAME);

      // Calculate desired session count
      // We want enough idle sessions to handle potential games + buffer
      const desiredIdle = Math.min(potentialGames + SCALE_UP_BUFFER, MAX_SESSIONS - busyCount);
      const desiredTotal = Math.max(MIN_SESSIONS, busyCount + desiredIdle);

      // Clamp to max
      const targetTotal = Math.min(desiredTotal, MAX_SESSIONS);

      // Scale up if needed
      if (totalSessions < targetTotal) {
        const toCreate = targetTotal - totalSessions;
        const created = await createSessions(toCreate);
        console.log(`SCALE_UP: +${created.length} sessions (queue=${queueDepth}, idle=${idleCount}, busy=${busyCount}, total=${totalSessions + created.length})`);
      }
      // Scale down if we have way too many idle sessions
      else if (idleCount > desiredIdle + SCALE_UP_BUFFER * 2 && totalSessions > MIN_SESSIONS) {
        const toRemove = Math.min(idleCount - desiredIdle - SCALE_UP_BUFFER, totalSessions - MIN_SESSIONS);
        if (toRemove > 0) {
          const removed = await removeIdleSessions(toRemove);
          if (removed > 0) {
            console.log(`SCALE_DOWN: -${removed} sessions (queue=${queueDepth}, idle=${idleCount - removed}, busy=${busyCount}, total=${totalSessions - removed})`);
          }
        }
      }

    } catch (err) {
      console.error("Auto-scaler error:", err);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

scaleLoop().catch((e) => {
  console.error(e);
  process.exit(1);
});
