/**
 * Proxmox Session Autoscaler
 * 
 * Automatically scales session runner containers on Proxmox based on player demand.
 * 
 * Features:
 * - Monitors Redis queue length and active player count
 * - Creates new session containers by cloning a template
 * - Destroys idle session containers when demand drops
 * - Respects min/max session limits
 * - Cooldown periods to prevent thrashing
 * 
 * Environment Variables:
 * - REDIS_URL: Redis connection string
 * - PROXMOX_HOST: Proxmox API host (e.g., 10.10.10.10:8006)
 * - PROXMOX_USER: API user (e.g., opnvdi@pam)
 * - PROXMOX_TOKEN_ID: API token ID
 * - PROXMOX_TOKEN_SECRET: API token secret
 * - MIN_SESSIONS: Minimum session count (default: 10)
 * - MAX_SESSIONS: Maximum session count (default: 300)
 * - PLAYERS_PER_SESSION: Players each session handles (default: 100)
 * - SESSION_TEMPLATE_VMID: VMID of session template (default: 9001)
 * - SESSION_VMID_START: First VMID for sessions (default: 200)
 * - SESSION_VMID_END: Last VMID for sessions (default: 499)
 * - PROXMOX_NODE: Node to create containers on (default: pve)
 */

import Redis from 'ioredis';
import https from 'https';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const config = {
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },
  proxmox: {
    host: process.env.PROXMOX_HOST || '10.10.10.10:8006',
    user: process.env.PROXMOX_USER || 'opnvdi@pam',
    tokenId: process.env.PROXMOX_TOKEN_ID || 'UI2',
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET || '',
    node: process.env.PROXMOX_NODE || 'pve'
  },
  scaling: {
    minSessions: parseInt(process.env.MIN_SESSIONS || '10'),
    maxSessions: parseInt(process.env.MAX_SESSIONS || '300'),
    playersPerSession: parseInt(process.env.PLAYERS_PER_SESSION || '100'),
    slotsPerSession: parseInt(process.env.SLOTS_PER_SESSION || '5'), // Games per container
    templateVmid: parseInt(process.env.SESSION_TEMPLATE_VMID || '9001'),
    vmidStart: parseInt(process.env.SESSION_VMID_START || '200'),
    vmidEnd: parseInt(process.env.SESSION_VMID_END || '499'),
    
    // Scaling thresholds
    scaleUpThreshold: 0.8,    // Scale up when 80% of slots are used
    scaleDownThreshold: 0.3,  // Scale down when only 30% of slots are used
    
    // Cooldowns (ms)
    scaleUpCooldown: 30000,   // 30 seconds between scale ups
    scaleDownCooldown: 300000, // 5 minutes before scaling down
    
    // Batch sizes
    scaleUpBatchSize: 5,      // Create 5 containers at a time
    scaleDownBatchSize: 3     // Remove 3 containers at a time
  },
  pollInterval: 5000 // Check every 5 seconds
};

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let redis: Redis;
let lastScaleUp = 0;
let lastScaleDown = 0;
let lowUsageSince = 0;

interface SessionContainer {
  vmid: number;
  name: string;
  status: string;
  sessionId?: string;
  playerCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxmox API
// ─────────────────────────────────────────────────────────────────────────────

async function proxmoxApi(method: string, path: string, body?: any): Promise<any> {
  const { host, user, tokenId, tokenSecret, node } = config.proxmox;
  
  return new Promise((resolve, reject) => {
    const url = new URL(`https://${host}${path}`);
    
    // Proxmox API requires form-urlencoded for POST/PUT
    const bodyString = body ? Object.entries(body)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&') : '';
    
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 8006,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `PVEAPIToken=${user}!${tokenId}=${tokenSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyString)
      },
      rejectUnauthorized: false // Skip SSL verification for self-signed certs
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
            return;
          }
          if (json.data !== undefined) {
            resolve(json.data);
          } else {
            resolve(json);
          }
        } catch (e) {
          resolve(data);
        }
      });
    });
    
    req.on('error', reject);
    
    if (bodyString) {
      req.write(bodyString);
    }
    
    req.end();
  });
}

/**
 * Get all session containers (VMIDs in the session range)
 */
async function getSessionContainers(): Promise<SessionContainer[]> {
  const { node } = config.proxmox;
  const { vmidStart, vmidEnd } = config.scaling;
  
  try {
    const containers = await proxmoxApi('GET', `/api2/json/nodes/${node}/lxc`);
    
    return containers
      .filter((ct: any) => ct.vmid >= vmidStart && ct.vmid <= vmidEnd)
      .map((ct: any) => ({
        vmid: ct.vmid,
        name: ct.name,
        status: ct.status
      }));
  } catch (err) {
    console.error('Failed to get containers:', err);
    return [];
  }
}

/**
 * Clone template to create new session container
 */
async function createSessionContainer(vmid: number): Promise<boolean> {
  const { node } = config.proxmox;
  const { templateVmid, vmidStart } = config.scaling;
  
  const sessionId = `session-${vmid}`;
  const ip = calculateIpForVmid(vmid);
  
  console.log(`Creating container ${vmid} (${sessionId}) with IP ${ip}...`);
  
  try {
    // Clone the template (linked clone for speed on ZFS)
    const upid = await proxmoxApi('POST', `/api2/json/nodes/${node}/lxc/${templateVmid}/clone`, {
      newid: vmid,
      hostname: sessionId,
      target: node
    });
    
    // Wait for clone to complete
    await waitForTask(upid);
    
    // Configure network
    await proxmoxApi('PUT', `/api2/json/nodes/${node}/lxc/${vmid}/config`, {
      net0: `name=eth0,bridge=vmbr0,ip=${ip}/24,gw=10.10.10.1`
    });
    
    // Start the container
    const startUpid = await proxmoxApi('POST', `/api2/json/nodes/${node}/lxc/${vmid}/status/start`);
    await waitForTask(startUpid);
    
    // Register in Redis
    await redis.hset(`session:${sessionId}`, {
      state: 'IDLE',
      vmid: vmid.toString(),
      ip: ip,
      startedAt: Date.now().toString()
    });
    
    console.log(`✓ Container ${vmid} created and started`);
    return true;
  } catch (err) {
    console.error(`Failed to create container ${vmid}:`, err);
    return false;
  }
}

/**
 * Stop and destroy a session container
 */
async function destroySessionContainer(vmid: number): Promise<boolean> {
  const { node } = config.proxmox;
  const sessionId = `session-${vmid}`;
  
  console.log(`Destroying container ${vmid} (${sessionId})...`);
  
  try {
    // Stop if running
    try {
      const stopUpid = await proxmoxApi('POST', `/api2/json/nodes/${node}/lxc/${vmid}/status/stop`);
      await waitForTask(stopUpid);
    } catch (e) {
      // Already stopped
    }
    
    // Destroy
    const destroyUpid = await proxmoxApi('DELETE', `/api2/json/nodes/${node}/lxc/${vmid}`);
    await waitForTask(destroyUpid);
    
    // Remove from Redis (session hash and availability sorted set)
    await redis.del(`session:${sessionId}`);
    await redis.zrem('sessions:available', sessionId);
    await redis.zrem('sessions:available', vmid.toString()); // Legacy format
    
    console.log(`✓ Container ${vmid} destroyed`);
    return true;
  } catch (err) {
    console.error(`Failed to destroy container ${vmid}:`, err);
    return false;
  }
}

/**
 * Wait for a Proxmox task to complete by polling its status
 */
async function waitForTask(upid: string, maxWait = 120000): Promise<void> {
  if (!upid) return;
  
  const { node } = config.proxmox;
  const start = Date.now();
  
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 1000));
    
    try {
      const status = await proxmoxApi('GET', `/api2/json/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
      
      if (status.status === 'stopped') {
        if (status.exitstatus === 'OK') {
          return; // Success
        } else {
          throw new Error(`Task failed: ${status.exitstatus}`);
        }
      }
    } catch (err) {
      // Task might not be found yet, keep polling
    }
  }
  
  throw new Error(`Task timed out after ${maxWait}ms`);
}

/**
 * Calculate IP address for a VMID
 * VMIDs 200-254 -> 10.10.10.200-254
 * VMIDs 255-499 -> 10.10.11.0-244
 */
function calculateIpForVmid(vmid: number): string {
  if (vmid <= 254) {
    return `10.10.10.${vmid}`;
  } else {
    return `10.10.11.${vmid - 255}`;
  }
}

/**
 * Find available VMIDs for new containers
 */
async function findAvailableVmids(count: number): Promise<number[]> {
  const { vmidStart, vmidEnd } = config.scaling;
  const existing = await getSessionContainers();
  const usedVmids = new Set(existing.map(c => c.vmid));
  
  const available: number[] = [];
  for (let vmid = vmidStart; vmid <= vmidEnd && available.length < count; vmid++) {
    if (!usedVmids.has(vmid)) {
      available.push(vmid);
    }
  }
  
  return available;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scaling Logic
// ─────────────────────────────────────────────────────────────────────────────

interface ScalingMetrics {
  queueLength: number;
  totalPlayers: number;
  totalSessions: number;
  totalSlots: number;
  usedSlots: number;
  availableSlots: number;
  runningGames: number;
  playersInGame: number;
  utilizationPercent: number;
}

async function getScalingMetrics(): Promise<ScalingMetrics> {
  // Get queue length
  const queueLength = await redis.llen('queue:ready');
  
  // Count players by state
  const playerKeys = await redis.keys('player:*');
  const totalPlayers = playerKeys.length;
  
  // Count sessions and their slots
  const sessionKeys = await redis.keys('session:*');
  let totalSessions = 0;
  let totalSlots = 0;
  let usedSlots = 0;
  
  for (const key of sessionKeys) {
    const sessionData = await redis.hgetall(key);
    const maxSlots = parseInt(sessionData.max_slots || config.scaling.slotsPerSession.toString());
    const activeGames = parseInt(sessionData.active_games || '0');
    
    totalSessions++;
    totalSlots += maxSlots;
    usedSlots += activeGames;
  }
  
  const availableSlots = totalSlots - usedSlots;
  
  // Count running games and players
  const playersInGame = await countPlayersInGame();
  const runningGames = usedSlots; // Each used slot = 1 running game
  
  const utilizationPercent = totalSlots > 0 
    ? (usedSlots / totalSlots) * 100 
    : 0;
  
  return {
    queueLength,
    totalPlayers,
    totalSessions,
    totalSlots,
    usedSlots,
    availableSlots,
    runningGames,
    playersInGame,
    utilizationPercent
  };
}

async function countPlayersInGame(): Promise<number> {
  const gameKeys = await redis.keys('game:*');
  let count = 0;
  
  // Filter to only game hashes (not game:*:players sets)
  const gameHashes = gameKeys.filter(key => !key.includes(':players'));
  
  for (const key of gameHashes) {
    try {
      const state = await redis.hget(key, 'state');
      if (state === 'RUNNING') {
        // Players are stored in a separate SET: game:{gameId}:players
        const gameId = key.replace('game:', '');
        const playerCount = await redis.scard(`game:${gameId}:players`);
        count += playerCount;
      }
    } catch (e) {
      // Skip keys with wrong type
    }
  }
  
  return count;
}

async function scaleUp(needed: number): Promise<void> {
  const now = Date.now();
  
  // Check cooldown
  if (now - lastScaleUp < config.scaling.scaleUpCooldown) {
    console.log('Scale up cooldown active, skipping...');
    return;
  }
  
  const containers = await getSessionContainers();
  const currentCount = containers.length;
  
  // Don't exceed max
  const maxToCreate = Math.min(
    needed,
    config.scaling.maxSessions - currentCount,
    config.scaling.scaleUpBatchSize
  );
  
  if (maxToCreate <= 0) {
    console.log('At max capacity, cannot scale up');
    return;
  }
  
  const vmids = await findAvailableVmids(maxToCreate);
  console.log(`\n🔼 SCALING UP: Creating ${vmids.length} new session containers`);
  
  for (const vmid of vmids) {
    await createSessionContainer(vmid);
  }
  
  lastScaleUp = now;
  lowUsageSince = 0; // Reset low usage timer
}

async function scaleDown(excess: number): Promise<void> {
  const now = Date.now();
  
  // Require sustained low usage before scaling down
  if (lowUsageSince === 0) {
    lowUsageSince = now;
    console.log('Low usage detected, starting cooldown timer...');
    return;
  }
  
  if (now - lowUsageSince < config.scaling.scaleDownCooldown) {
    const remaining = Math.round((config.scaling.scaleDownCooldown - (now - lowUsageSince)) / 1000);
    console.log(`Scale down in ${remaining}s if usage stays low...`);
    return;
  }
  
  const containers = await getSessionContainers();
  const currentCount = containers.length;
  
  // Remove all excess at once (down to minSessions)
  const maxToRemove = Math.min(
    excess,
    currentCount - config.scaling.minSessions
  );
  
  if (maxToRemove <= 0) {
    console.log('At minimum capacity, cannot scale down');
    return;
  }
  
  // Find idle containers to remove
  const idleContainers: SessionContainer[] = [];
  for (const ct of containers) {
    const sessionId = `session-${ct.vmid}`;
    const state = await redis.hget(`session:${sessionId}`, 'state');
    if (state === 'IDLE' || !state) {
      idleContainers.push(ct);
    }
  }
  
  // Sort by VMID descending (remove highest first)
  idleContainers.sort((a, b) => b.vmid - a.vmid);
  
  const toRemove = idleContainers.slice(0, maxToRemove);
  console.log(`\n🔽 SCALING DOWN: Removing ${toRemove.length} idle session containers`);
  
  for (const ct of toRemove) {
    await destroySessionContainer(ct.vmid);
  }
  
  lastScaleDown = now;
  lowUsageSince = 0;
}

/**
 * Reconcile Redis session entries with actual Proxmox containers
 * Removes orphaned Redis entries that don't have corresponding containers
 * Also removes duplicate entries (both session:200 and session:session-200)
 */
async function reconcileSessions(): Promise<void> {
  const containers = await getSessionContainers();
  
  // Safety check: if API returns no containers, don't delete Redis entries
  // This prevents wiping all sessions on API failure
  if (containers.length === 0) {
    console.log('⚠️ Skipping reconciliation: no containers returned from Proxmox API');
    return;
  }
  
  const existingVmids = new Set(containers.map(c => c.vmid));
  
  // Get all session keys from Redis (handles both formats)
  const sessionKeys = await redis.keys('session:*');
  
  // Group keys by VMID to detect duplicates
  const vmidToKeys = new Map<number, string[]>();
  
  for (const key of sessionKeys) {
    let vmid: number | null = null;
    
    const match1 = key.match(/^session:session-(\d+)$/);
    const match2 = key.match(/^session:(\d+)$/);
    
    if (match1) {
      vmid = parseInt(match1[1]);
    } else if (match2) {
      vmid = parseInt(match2[1]);
    }
    
    if (vmid !== null) {
      if (!vmidToKeys.has(vmid)) {
        vmidToKeys.set(vmid, []);
      }
      vmidToKeys.get(vmid)!.push(key);
    }
  }
  
  let cleaned = 0;
  
  for (const [vmid, keys] of vmidToKeys) {
    if (!existingVmids.has(vmid)) {
      // Container doesn't exist - delete all keys for this VMID
      for (const key of keys) {
        await redis.del(key);
        cleaned++;
      }
    } else if (keys.length > 1) {
      // Duplicate keys - keep session:session-XXX, delete session:XXX
      const toKeep = keys.find(k => k.startsWith('session:session-')) || keys[0];
      for (const key of keys) {
        if (key !== toKeep) {
          await redis.del(key);
          cleaned++;
        }
      }
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} orphaned/duplicate Redis session entries`);
  }
  
  // Sync sessions:available sorted set with actual session hashes
  // Matchmaker uses this sorted set to find sessions with available slots
  const availableMembers = await redis.zrange('sessions:available', 0, -1, 'WITHSCORES');
  const currentAvailable = new Map<string, number>();
  for (let i = 0; i < availableMembers.length; i += 2) {
    currentAvailable.set(availableMembers[i], parseInt(availableMembers[i + 1]));
  }
  
  // Get current session slots from hashes
  const currentSessionKeys = await redis.keys('session:*');
  const actualAvailability = new Map<string, number>();
  
  for (const key of currentSessionKeys) {
    const sessionData = await redis.hgetall(key);
    const maxSlots = parseInt(sessionData.max_slots || config.scaling.slotsPerSession.toString());
    const activeGames = parseInt(sessionData.active_games || '0');
    const availableSlots = maxSlots - activeGames;
    
    // Extract session ID from key
    const sessionId = key.replace('session:', '');
    
    if (availableSlots > 0) {
      actualAvailability.set(sessionId, availableSlots);
    }
  }
  
  // Add/update sessions in sorted set
  let addedToSet = 0;
  let updatedInSet = 0;
  for (const [sessionId, slots] of actualAvailability) {
    const currentScore = currentAvailable.get(sessionId);
    if (currentScore === undefined) {
      await redis.zadd('sessions:available', slots, sessionId);
      addedToSet++;
    } else if (currentScore !== slots) {
      await redis.zadd('sessions:available', slots, sessionId);
      updatedInSet++;
    }
  }
  
  // Remove sessions that shouldn't be in available set
  let removedFromSet = 0;
  for (const sessionId of currentAvailable.keys()) {
    if (!actualAvailability.has(sessionId)) {
      await redis.zrem('sessions:available', sessionId);
      removedFromSet++;
    }
  }
  
  // Also clean up old sessions:idle set (legacy)
  await redis.del('sessions:idle');
  
  if (addedToSet > 0 || updatedInSet > 0 || removedFromSet > 0) {
    console.log(`🔄 Synced sessions:available: +${addedToSet} added, ~${updatedInSet} updated, -${removedFromSet} removed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Loop
// ─────────────────────────────────────────────────────────────────────────────

async function checkAndScale(): Promise<void> {
  // First reconcile Redis with actual Proxmox state
  await reconcileSessions();
  
  const metrics = await getScalingMetrics();
  
  console.log('\n' + '─'.repeat(60));
  console.log(`📊 Autoscaler Metrics @ ${new Date().toLocaleTimeString()}`);
  console.log('─'.repeat(60));
  console.log(`Queue:        ${metrics.queueLength} players waiting`);
  console.log(`Total Players:${metrics.totalPlayers}`);
  console.log(`Players In Game: ${metrics.playersInGame}`);
  console.log(`Sessions:     ${metrics.totalSessions} (${metrics.runningGames} games running)`);
  console.log(`Slots:        ${metrics.usedSlots}/${metrics.totalSlots} used (${metrics.utilizationPercent.toFixed(1)}%)`);
  console.log(`Available:    ${metrics.availableSlots} slots`);
  
  const { scaleUpThreshold, scaleDownThreshold, slotsPerSession, playersPerSession, minSessions, maxSessions } = config.scaling;
  
  // Calculate needed sessions based on (players in game + queue) / players per session / slots per session
  const totalDemand = metrics.playersInGame + metrics.queueLength;
  const gamesNeeded = Math.ceil(totalDemand / playersPerSession);
  const sessionsNeeded = Math.ceil(gamesNeeded / slotsPerSession);
  const clampedNeeded = Math.max(minSessions, Math.min(maxSessions, sessionsNeeded));
  
  console.log(`Needed:       ${clampedNeeded} sessions (have ${metrics.totalSessions})`);
  
  // CRITICAL: If queue has players waiting but no available slots, scale up immediately
  if (metrics.queueLength >= playersPerSession && metrics.availableSlots === 0 && metrics.totalSessions < maxSessions) {
    // Calculate how many sessions needed to handle current queue
    const gamesForQueue = Math.ceil(metrics.queueLength / playersPerSession);
    const sessionsForQueue = Math.ceil(gamesForQueue / slotsPerSession);
    const additionalNeeded = Math.min(sessionsForQueue, maxSessions - metrics.totalSessions);
    
    if (additionalNeeded > 0) {
      console.log(`\n🚨 Slot starvation: ${metrics.queueLength} players waiting, 0 slots available!`);
      console.log(`   Need ${additionalNeeded} more sessions (${additionalNeeded * slotsPerSession} slots)`);
      await scaleUp(additionalNeeded);
      return;
    }
  }
  
  if (metrics.utilizationPercent > scaleUpThreshold * 100) {
    // High utilization - need more capacity
    const deficit = clampedNeeded - metrics.totalSessions;
    if (deficit > 0) {
      console.log(`\n⚠️  High utilization (${metrics.utilizationPercent.toFixed(1)}%) - need ${deficit} more sessions`);
      await scaleUp(deficit);
    }
  } else if (metrics.utilizationPercent < scaleDownThreshold * 100 && metrics.totalSessions > minSessions) {
    // Low utilization - can reduce capacity
    const excess = metrics.totalSessions - Math.max(minSessions, clampedNeeded);
    if (excess > 0) {
      console.log(`\n📉 Low utilization (${metrics.utilizationPercent.toFixed(1)}%) - ${excess} excess sessions`);
      await scaleDown(excess);
    }
  } else {
    lowUsageSince = 0; // Reset low usage timer
    console.log('\n✓ Capacity is balanced');
  }
}

async function ensureMinimumSessions(): Promise<void> {
  const containers = await getSessionContainers();
  const currentCount = containers.length;
  const { minSessions } = config.scaling;
  
  if (currentCount < minSessions) {
    const needed = minSessions - currentCount;
    console.log(`\n🚀 Bootstrap: Creating ${needed} initial session containers...`);
    const vmids = await findAvailableVmids(needed);
    
    for (const vmid of vmids) {
      await createSessionContainer(vmid);
    }
  }
}

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('   PROXMOX SESSION AUTOSCALER (Multi-Game)');
  console.log('═'.repeat(60));
  console.log('\nConfiguration:');
  console.log(`  Min Sessions:    ${config.scaling.minSessions}`);
  console.log(`  Max Sessions:    ${config.scaling.maxSessions}`);
  console.log(`  Slots/Session:   ${config.scaling.slotsPerSession} games`);
  console.log(`  Players/Game:    ${config.scaling.playersPerSession}`);
  console.log(`  Max Capacity:    ${config.scaling.maxSessions * config.scaling.slotsPerSession} games (${config.scaling.maxSessions * config.scaling.slotsPerSession * config.scaling.playersPerSession} players)`);
  console.log(`  Template VMID:   ${config.scaling.templateVmid}`);
  console.log(`  Session VMIDs:   ${config.scaling.vmidStart}-${config.scaling.vmidEnd}`);
  console.log(`  Proxmox Node:    ${config.proxmox.node}`);
  console.log(`  Poll Interval:   ${config.pollInterval / 1000}s`);
  console.log('');
  
  // Connect to Redis
  redis = new Redis(config.redis.url);
  
  redis.on('connect', () => console.log('✓ Connected to Redis'));
  redis.on('error', (err) => console.error('Redis error:', err));
  
  // Wait for connection
  await new Promise<void>((resolve) => {
    redis.once('ready', resolve);
  });
  
  // Ensure minimum sessions exist
  await ensureMinimumSessions();
  
  // Start scaling loop
  console.log('\n🔄 Starting autoscaler loop...\n');
  
  setInterval(checkAndScale, config.pollInterval);
  checkAndScale(); // Initial check
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down autoscaler...');
  await redis.quit();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n\nShutting down autoscaler...');
  await redis.quit();
  process.exit(0);
});

main().catch(console.error);
