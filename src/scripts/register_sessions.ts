import Redis from "ioredis";
import { randomUUID } from "crypto";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const COUNT = Number(process.env.SESSIONS ?? 20);

// Create a batch of idle sessions for the matchmaker to claim.
async function main() {
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

  for (let i = 0; i < COUNT; i++) {
    const sessionId = randomUUID();

    // Mark each session as IDLE and add it to the idle pool.
    await redis.hset(`session:${sessionId}`, {
      state: "IDLE",
      updated_at: Date.now().toString(),
    });

    await redis.sadd("sessions:idle", sessionId);
  }

  const idle = await redis.scard("sessions:idle");
  console.log(`Registered ${COUNT} sessions. Idle now: ${idle}`);

  // Clean shutdown.
  await redis.quit();
}

// Fail fast on unexpected errors.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
