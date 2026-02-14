import Redis from "ioredis";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const STALE_MS = Number(process.env.STALE_MS ?? 30_000);
const LOOP_MS = Number(process.env.LOOP_MS ?? 5_000);
const SCAN_BATCH = Number(process.env.SCAN_BATCH ?? 200);

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isStale(heartbeatAt: string | null, now: number) {
  const ts = Number(heartbeatAt ?? "0");
  return !ts || now - ts > STALE_MS;
}

async function cleanupReadyQueue(now: number) {
  const queue = await redis.lrange("queue:ready", 0, -1);
  if (queue.length === 0) return;

  const pipe = redis.pipeline();
  for (const playerId of queue) {
    pipe.hget(`player:${playerId}`, "state");
    pipe.hget(`player:${playerId}`, "heartbeat_at");
  }

  const results = await pipe.exec();
  if (!results) return;

  for (let i = 0; i < queue.length; i++) {
    const playerId = queue[i];
    const state = results[i * 2]?.[1] as string | null;
    const heartbeatAt = results[i * 2 + 1]?.[1] as string | null;

    if (state !== "READY" || isStale(heartbeatAt, now)) {
      await redis.lrem("queue:ready", 0, playerId);
    }
  }
}

async function cleanupPlayers(now: number) {
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "player:*", "COUNT", SCAN_BATCH);
    cursor = nextCursor;

    if (keys.length === 0) continue;

    const pipe = redis.pipeline();
    for (const key of keys) {
      pipe.hget(key, "state");
      pipe.hget(key, "heartbeat_at");
    }

    const results = await pipe.exec();
    if (!results) continue;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const state = results[i * 2]?.[1] as string | null;
      const heartbeatAt = results[i * 2 + 1]?.[1] as string | null;

      if (!isStale(heartbeatAt, now)) continue;

      const playerId = key.split(":")[1] ?? "";
      if (playerId) {
        await redis.lrem("queue:ready", 0, playerId);
      }

      // Stale players are returned to lobby and cleared.
      await redis.hset(key, {
        state: "IN_LOBBY",
        game_id: "",
        session_id: "",
      });
    }
  } while (cursor !== "0");
}

async function main() {
  console.log(`Reaper starting. Redis at ${REDIS_HOST}:${REDIS_PORT}`);

  while (true) {
    const now = Date.now();
    await cleanupReadyQueue(now);
    await cleanupPlayers(now);
    await sleep(LOOP_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
