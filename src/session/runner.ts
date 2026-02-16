import Redis from "ioredis";
import { randomUUID } from "crypto";
import { hostname } from "os";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

// Multi-game support: max concurrent games per session
const MAX_SLOTS = Number(process.env.MAX_SLOTS ?? 5);

// Session ID priority: 1) SESSION_ID env, 2) hostname (e.g. session-200), 3) random UUID
function getSessionId(): string {
  if (process.env.SESSION_ID?.trim()) {
    return process.env.SESSION_ID.trim();
  }
  
  const host = hostname();
  // If hostname looks like a session ID (e.g. session-200), use it
  if (host.startsWith('session-')) {
    return host;
  }
  
  // Fallback to random UUID
  return randomUUID();
}

const SESSION_ID = getSessionId();

// Poll intervals
const ACTIVE_POLL_MS = 500;
const FINISH_LOCK_MS = 5_000;

// Shared Redis client for session/game state.
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

// Track active games for this session
const activeGames = new Set<string>();

// Simple async delay helper.
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Register/update session availability in sorted set
// Score = available slots (higher = more capacity)
async function updateAvailability() {
  const availableSlots = MAX_SLOTS - activeGames.size;
  const gameIds = Array.from(activeGames).join(',');
  
  const pipe = redis.pipeline();
  
  // Update session hash
  pipe.hset(`session:${SESSION_ID}`, {
    max_slots: MAX_SLOTS.toString(),
    active_games: activeGames.size.toString(),
    game_ids: gameIds,
    available_slots: availableSlots.toString(),
    updated_at: Date.now().toString(),
  });
  
  if (availableSlots > 0) {
    // Add to available pool with score = available slots
    pipe.zadd('sessions:available', availableSlots, SESSION_ID);
  } else {
    // Full - remove from available pool
    pipe.zrem('sessions:available', SESSION_ID);
  }
  
  await pipe.exec();
}

// Register the session on startup
async function registerSession() {
  // Check for any games already assigned to this session (recovery after restart)
  const existing = await redis.hgetall(`session:${SESSION_ID}`);
  if (existing.game_ids) {
    const gameIds = existing.game_ids.split(',').filter(id => id);
    for (const gameId of gameIds) {
      // Verify game is still running
      const state = await redis.hget(`game:${gameId}`, 'state');
      if (state === 'RUNNING') {
        activeGames.add(gameId);
      }
    }
  }
  
  await updateAvailability();
  console.log(`Registered session with ${MAX_SLOTS} slots, ${activeGames.size} active games`);
}

// Finish a game and free up a slot
async function finishGame(gameId: string) {
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

  await pipe.exec();

  // Remove from our active set
  activeGames.delete(gameId);
  
  // Update availability (opens up a slot)
  await updateAvailability();

  // Publish match_ended so gateway can notify clients
  await redis.publish(
    "events:match_ended",
    JSON.stringify({ gameId, sessionId: SESSION_ID, playerIds })
  );

  console.log(`MATCH_ENDED game=${gameId} session=${SESSION_ID} players=${playerIds.length} slots=${MAX_SLOTS - activeGames.size}/${MAX_SLOTS}`);
}

async function acquireFinishLock(gameId: string): Promise<boolean> {
  const res = await redis.set(`lock:finish:${gameId}`, "1", "PX", FINISH_LOCK_MS, "NX");
  return res === "OK";
}

// Check for newly assigned games from matchmaker
async function checkForNewGames() {
  const sessionData = await redis.hgetall(`session:${SESSION_ID}`);
  const gameIds = (sessionData.game_ids || '').split(',').filter(id => id);
  
  for (const gameId of gameIds) {
    if (!activeGames.has(gameId)) {
      // New game assigned - verify it exists and is running
      const state = await redis.hget(`game:${gameId}`, 'state');
      if (state === 'RUNNING') {
        activeGames.add(gameId);
        console.log(`NEW_GAME game=${gameId} session=${SESSION_ID} slots=${MAX_SLOTS - activeGames.size}/${MAX_SLOTS}`);
      }
    }
  }
}

// Process our active games - check if any have ended
async function processActiveGames() {
  const now = Date.now();
  
  for (const gameId of activeGames) {
    const game = await redis.hgetall(`game:${gameId}`);
    
    // Game might have been deleted or finished by another process
    if (!game || Object.keys(game).length === 0 || game.state === 'FINISHED') {
      activeGames.delete(gameId);
      await updateAvailability();
      continue;
    }
    
    const endAt = Number(game.end_at ?? "0");

    if (!endAt) {
      console.warn(`Game missing end_at; finishing now. game=${gameId}`);
      if (await acquireFinishLock(gameId)) {
        await finishGame(gameId);
      }
      continue;
    }

    if (now >= endAt) {
      if (await acquireFinishLock(gameId)) {
        await finishGame(gameId);
      }
    }
  }
}

async function main() {
  console.log(`Session runner starting: session=${SESSION_ID} maxSlots=${MAX_SLOTS} Redis=${REDIS_HOST}:${REDIS_PORT}`);

  await registerSession();

  while (true) {
    await checkForNewGames();
    await processActiveGames();
    await sleep(ACTIVE_POLL_MS);
  }
}

// Exit on unexpected errors.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
