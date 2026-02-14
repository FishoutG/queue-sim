/**
 * Auto-Scale Sessions
 * 
 * Monitors queue demand and automatically scales session count up/down.
 * 
 * Environment variables:
 *   MIN_SESSIONS     - Minimum sessions to keep (default: 5)
 *   MAX_SESSIONS     - Maximum sessions allowed (default: 100)
 *   SCALE_UP_THRESHOLD  - Queue size per idle session to trigger scale up (default: 100)
 *   SCALE_DOWN_IDLE     - Idle sessions threshold to trigger scale down (default: 20)
 *   CHECK_INTERVAL_MS   - How often to check (default: 2000)
 */

import Redis from "ioredis";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import path from "path";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

// Scaling config
const MIN_SESSIONS = Number(process.env.MIN_SESSIONS ?? 5);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 100);
const SCALE_UP_THRESHOLD = Number(process.env.SCALE_UP_THRESHOLD ?? 100); // Queue/idle ratio
const SCALE_DOWN_IDLE = Number(process.env.SCALE_DOWN_IDLE ?? 20); // If this many idle, scale down
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS ?? 2000);
const BATCH_SIZE = 5; // Sessions to add/remove at once

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

// Track spawned session runner processes
const sessionProcesses = new Map<string, ChildProcess>();

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// Spawn a new session runner process
function spawnSessionRunner(sessionId: string): ChildProcess {
  const runnerPath = path.join(__dirname, "..", "session", "runner.ts");
  
  const proc = spawn("npx", ["ts-node", "--transpile-only", runnerPath], {
    env: {
      ...process.env,
      SESSION_ID: sessionId,
    },
    stdio: "inherit",
  });
  
  proc.on("exit", (code) => {
    console.log(`Session ${sessionId} exited with code ${code}`);
    sessionProcesses.delete(sessionId);
  });
  
  return proc;
}

// Register a session in Redis (for sessions without a runner process)
async function registerSession(sessionId: string) {
  await redis.hset(`session:${sessionId}`, {
    state: "IDLE",
    game_id: "",
    updated_at: Date.now().toString(),
  });
  await redis.sadd("sessions:idle", sessionId);
}

// Scale up by adding new sessions
async function scaleUp(count: number) {
  console.log(`SCALE UP: Adding ${count} sessions`);
  
  for (let i = 0; i < count; i++) {
    const sessionId = randomUUID();
    await registerSession(sessionId);
    // Note: If you want actual session runner processes, use spawnSessionRunner(sessionId)
  }
  
  const idle = await redis.scard("sessions:idle");
  console.log(`Scale up complete. Idle sessions: ${idle}`);
}

// Scale down by removing idle sessions
async function scaleDown(count: number) {
  console.log(`SCALE DOWN: Removing ${count} idle sessions`);
  
  let removed = 0;
  for (let i = 0; i < count; i++) {
    const sessionId = await redis.spop("sessions:idle");
    if (!sessionId) break;
    
    // Remove session data
    await redis.del(`session:${sessionId}`);
    removed++;
    
    // Kill process if we spawned it
    const proc = sessionProcesses.get(sessionId);
    if (proc) {
      proc.kill();
      sessionProcesses.delete(sessionId);
    }
  }
  
  const idle = await redis.scard("sessions:idle");
  console.log(`Scale down complete. Removed ${removed}. Idle sessions: ${idle}`);
}

// Get current metrics
async function getMetrics() {
  const [queueSize, idleSessions, totalSessions] = await Promise.all([
    redis.llen("queue:ready"),
    redis.scard("sessions:idle"),
    redis.keys("session:*").then(k => k.length),
  ]);
  
  return { queueSize, idleSessions, totalSessions };
}

// Main auto-scaling loop
async function main() {
  console.log(`Auto-scaler starting:`);
  console.log(`  MIN_SESSIONS: ${MIN_SESSIONS}`);
  console.log(`  MAX_SESSIONS: ${MAX_SESSIONS}`);
  console.log(`  SCALE_UP_THRESHOLD: ${SCALE_UP_THRESHOLD} (queue/idle ratio)`);
  console.log(`  SCALE_DOWN_IDLE: ${SCALE_DOWN_IDLE}`);
  console.log(`  CHECK_INTERVAL_MS: ${CHECK_INTERVAL_MS}`);
  
  // Ensure minimum sessions on startup
  const { idleSessions: initialIdle } = await getMetrics();
  if (initialIdle < MIN_SESSIONS) {
    await scaleUp(MIN_SESSIONS - initialIdle);
  }
  
  // Main loop
  while (true) {
    try {
      const { queueSize, idleSessions, totalSessions } = await getMetrics();
      
      // Calculate demand ratio
      const demandRatio = idleSessions > 0 ? queueSize / idleSessions : queueSize;
      
      console.log(`Metrics: queue=${queueSize} idle=${idleSessions} total=${totalSessions} demand=${demandRatio.toFixed(1)}`);
      
      // Scale up if demand is high and we're under max
      if (demandRatio >= SCALE_UP_THRESHOLD && totalSessions < MAX_SESSIONS) {
        const toAdd = Math.min(BATCH_SIZE, MAX_SESSIONS - totalSessions);
        if (toAdd > 0) {
          await scaleUp(toAdd);
        }
      }
      // Scale down if too many idle sessions (but keep minimum)
      else if (idleSessions > SCALE_DOWN_IDLE && idleSessions > MIN_SESSIONS) {
        const toRemove = Math.min(BATCH_SIZE, idleSessions - MIN_SESSIONS);
        if (toRemove > 0) {
          await scaleDown(toRemove);
        }
      }
    } catch (err) {
      console.error("Auto-scale error:", err);
    }
    
    await sleep(CHECK_INTERVAL_MS);
  }
}

// Handle shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down auto-scaler...");
  
  // Kill all spawned session processes
  for (const [id, proc] of sessionProcesses) {
    console.log(`Killing session ${id}`);
    proc.kill();
  }
  
  await redis.quit();
  process.exit(0);
});

main().catch(e => {
  console.error(e);
  process.exit(1);
});
