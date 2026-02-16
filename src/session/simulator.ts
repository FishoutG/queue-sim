/**
 * Game Simulation Module
 * 
 * Provides configurable CPU/memory load to simulate real game server workloads.
 * Used by the session runner to stress test infrastructure.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export type LoadProfile = 'minimal' | 'light' | 'medium' | 'heavy' | 'battleroyale';

export interface SimulatorConfig {
  profile: LoadProfile;
  tickRate: number;           // Updates per second
  worldSize: number;          // Grid cells (worldSize x worldSize)
  physicsEnabled: boolean;
  collisionEnabled: boolean;
  pathfindingEnabled: boolean;
  memoryMB: number;           // Target memory allocation per game
}

const PROFILES: Record<LoadProfile, Partial<SimulatorConfig>> = {
  minimal: {
    tickRate: 1,
    worldSize: 64,
    physicsEnabled: false,
    collisionEnabled: false,
    pathfindingEnabled: false,
    memoryMB: 5
  },
  light: {
    tickRate: 10,
    worldSize: 256,
    physicsEnabled: true,
    collisionEnabled: false,
    pathfindingEnabled: false,
    memoryMB: 25
  },
  medium: {
    tickRate: 20,
    worldSize: 512,
    physicsEnabled: true,
    collisionEnabled: true,
    pathfindingEnabled: false,
    memoryMB: 75
  },
  heavy: {
    tickRate: 30,
    worldSize: 1024,
    physicsEnabled: true,
    collisionEnabled: true,
    pathfindingEnabled: true,
    memoryMB: 150
  },
  battleroyale: {
    tickRate: 60,
    worldSize: 2048,
    physicsEnabled: true,
    collisionEnabled: true,
    pathfindingEnabled: true,
    memoryMB: 300
  }
};

function getConfig(): SimulatorConfig {
  const profile = (process.env.LOAD_PROFILE || 'light') as LoadProfile;
  const defaults = PROFILES[profile] || PROFILES.light;
  
  return {
    profile,
    tickRate: parseInt(process.env.TICK_RATE || '') || defaults.tickRate || 60,
    worldSize: parseInt(process.env.WORLD_SIZE || '') || defaults.worldSize || 2048,
    physicsEnabled: process.env.PHYSICS_ENABLED !== 'false' && (defaults.physicsEnabled ?? true),
    collisionEnabled: process.env.COLLISION_ENABLED !== 'false' && (defaults.collisionEnabled ?? true),
    pathfindingEnabled: process.env.PATHFINDING_ENABLED !== 'false' && (defaults.pathfindingEnabled ?? true),
    memoryMB: parseInt(process.env.MEMORY_MB || '') || defaults.memoryMB || 300
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

interface PlayerState {
  id: string;
  position: Vector3;
  velocity: Vector3;
  health: number;
  armor: number;
  inventory: number[];
  visiblePlayers: string[];
  lastHit: number;
  kills: number;
  damageDealt: number;
}

interface WorldCell {
  terrain: number;
  height: number;
  objects: number[];
  navWeight: number;
}

interface GameStats {
  tickCount: number;
  avgTickMs: number;
  maxTickMs: number;
  collisionChecks: number;
  pathfindOps: number;
  memoryUsedMB: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// BattleRoyaleSimulator
// ─────────────────────────────────────────────────────────────────────────────

export class BattleRoyaleSimulator {
  private config: SimulatorConfig;
  private gameId: string;
  private playerIds: string[];
  private running: boolean = false;
  private tickInterval: NodeJS.Timeout | null = null;
  
  // Game state
  private players: Map<string, PlayerState> = new Map();
  private world: WorldCell[][] = [];
  private memoryBuffer: Buffer | null = null;
  
  // Stats tracking
  private stats: GameStats = {
    tickCount: 0,
    avgTickMs: 0,
    maxTickMs: 0,
    collisionChecks: 0,
    pathfindOps: 0,
    memoryUsedMB: 0
  };
  private tickTimes: number[] = [];

  constructor(gameId: string, playerIds: string[]) {
    this.config = getConfig();
    this.gameId = gameId;
    this.playerIds = playerIds;
  }

  /**
   * Start the game simulation
   */
  start(): void {
    if (this.running) return;
    
    console.log(`[SIM:${this.gameId.slice(0, 8)}] Starting ${this.config.profile} simulation`);
    console.log(`[SIM:${this.gameId.slice(0, 8)}] Config: ${this.config.tickRate}Hz, ${this.config.worldSize}x${this.config.worldSize} world, ${this.config.memoryMB}MB RAM`);
    
    this.running = true;
    this.initializeWorld();
    this.initializePlayers();
    this.allocateMemory();
    
    // Start tick loop
    const tickMs = 1000 / this.config.tickRate;
    this.tickInterval = setInterval(() => this.tick(), tickMs);
  }

  /**
   * Stop the simulation and release resources
   */
  stop(): GameStats {
    if (!this.running) return this.stats;
    
    this.running = false;
    
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    
    // Calculate final stats
    if (this.tickTimes.length > 0) {
      this.stats.avgTickMs = this.tickTimes.reduce((a, b) => a + b, 0) / this.tickTimes.length;
    }
    
    console.log(`[SIM:${this.gameId.slice(0, 8)}] Stopped after ${this.stats.tickCount} ticks`);
    console.log(`[SIM:${this.gameId.slice(0, 8)}] Avg tick: ${this.stats.avgTickMs.toFixed(2)}ms, Max: ${this.stats.maxTickMs.toFixed(2)}ms`);
    console.log(`[SIM:${this.gameId.slice(0, 8)}] Collisions: ${this.stats.collisionChecks}, Pathfind: ${this.stats.pathfindOps}`);
    
    // Release memory
    this.players.clear();
    this.world = [];
    this.memoryBuffer = null;
    
    // Force GC if available
    if (global.gc) {
      global.gc();
    }
    
    return this.stats;
  }

  /**
   * Get current simulation stats
   */
  getStats(): GameStats {
    return { ...this.stats };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  private initializeWorld(): void {
    const size = this.config.worldSize;
    this.world = [];
    
    for (let x = 0; x < size; x++) {
      this.world[x] = [];
      for (let y = 0; y < size; y++) {
        this.world[x][y] = {
          terrain: Math.floor(Math.random() * 10),
          height: Math.sin(x / 50) * Math.cos(y / 50) * 100 + Math.random() * 20,
          objects: Math.random() > 0.95 ? [Math.floor(Math.random() * 100)] : [],
          navWeight: 1 + Math.random() * 0.5
        };
      }
    }
  }

  private initializePlayers(): void {
    const size = this.config.worldSize;
    
    for (const id of this.playerIds) {
      const state: PlayerState = {
        id,
        position: {
          x: Math.random() * size,
          y: Math.random() * size,
          z: 0
        },
        velocity: {
          x: (Math.random() - 0.5) * 10,
          y: (Math.random() - 0.5) * 10,
          z: 0
        },
        health: 100,
        armor: Math.floor(Math.random() * 50),
        inventory: Array(20).fill(0).map(() => Math.floor(Math.random() * 1000)),
        visiblePlayers: [],
        lastHit: 0,
        kills: 0,
        damageDealt: 0
      };
      
      // Set Z from terrain height
      const wx = Math.floor(state.position.x) % size;
      const wy = Math.floor(state.position.y) % size;
      state.position.z = this.world[wx]?.[wy]?.height ?? 0;
      
      this.players.set(id, state);
    }
  }

  private allocateMemory(): void {
    // Allocate buffer to simulate game state memory
    const targetBytes = this.config.memoryMB * 1024 * 1024;
    const worldBytes = this.config.worldSize * this.config.worldSize * 32; // Approx world size
    const additionalBytes = Math.max(0, targetBytes - worldBytes);
    
    if (additionalBytes > 0) {
      this.memoryBuffer = Buffer.alloc(additionalBytes);
      // Write random data to prevent optimization
      for (let i = 0; i < additionalBytes; i += 4096) {
        this.memoryBuffer.writeUInt32LE(Math.random() * 0xFFFFFFFF, i);
      }
    }
    
    this.stats.memoryUsedMB = (worldBytes + additionalBytes) / (1024 * 1024);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Game Loop
  // ─────────────────────────────────────────────────────────────────────────

  private tick(): void {
    const start = performance.now();
    
    if (this.config.physicsEnabled) {
      this.updatePhysics();
    }
    
    if (this.config.collisionEnabled) {
      this.checkCollisions();
    }
    
    if (this.config.pathfindingEnabled) {
      this.updatePathfinding();
    }
    
    // Simulate game logic - visibility, damage, etc.
    this.updateGameLogic();
    
    // Simulate state serialization overhead
    this.serializeState();
    
    const elapsed = performance.now() - start;
    this.stats.tickCount++;
    this.tickTimes.push(elapsed);
    
    if (elapsed > this.stats.maxTickMs) {
      this.stats.maxTickMs = elapsed;
    }
    
    // Keep only last 100 tick times for rolling average
    if (this.tickTimes.length > 100) {
      this.tickTimes.shift();
    }
  }

  private updatePhysics(): void {
    const deltaTime = 1 / this.config.tickRate;
    const size = this.config.worldSize;
    
    for (const player of this.players.values()) {
      // Apply velocity
      player.position.x += player.velocity.x * deltaTime;
      player.position.y += player.velocity.y * deltaTime;
      
      // Wrap around world
      player.position.x = ((player.position.x % size) + size) % size;
      player.position.y = ((player.position.y % size) + size) % size;
      
      // Update height from terrain
      const wx = Math.floor(player.position.x);
      const wy = Math.floor(player.position.y);
      const targetZ = this.world[wx]?.[wy]?.height ?? 0;
      player.position.z += (targetZ - player.position.z) * 0.1;
      
      // Apply friction
      player.velocity.x *= 0.98;
      player.velocity.y *= 0.98;
      
      // Random movement changes (simulate player input)
      if (Math.random() > 0.9) {
        player.velocity.x += (Math.random() - 0.5) * 5;
        player.velocity.y += (Math.random() - 0.5) * 5;
      }
      
      // Clamp velocity
      const maxSpeed = 20;
      const speed = Math.sqrt(player.velocity.x ** 2 + player.velocity.y ** 2);
      if (speed > maxSpeed) {
        player.velocity.x = (player.velocity.x / speed) * maxSpeed;
        player.velocity.y = (player.velocity.y / speed) * maxSpeed;
      }
    }
  }

  private checkCollisions(): void {
    const players = Array.from(this.players.values());
    const collisionRadius = 2;
    
    // O(n²) collision detection
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        this.stats.collisionChecks++;
        
        const p1 = players[i];
        const p2 = players[j];
        
        const dx = p1.position.x - p2.position.x;
        const dy = p1.position.y - p2.position.y;
        const dz = p1.position.z - p2.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        
        if (distSq < collisionRadius * collisionRadius) {
          // Collision response - push apart
          const dist = Math.sqrt(distSq) || 0.1;
          const overlap = collisionRadius - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          
          p1.position.x += nx * overlap * 0.5;
          p1.position.y += ny * overlap * 0.5;
          p2.position.x -= nx * overlap * 0.5;
          p2.position.y -= ny * overlap * 0.5;
        }
      }
    }
    
    // World object collisions
    for (const player of players) {
      const wx = Math.floor(player.position.x) % this.config.worldSize;
      const wy = Math.floor(player.position.y) % this.config.worldSize;
      const cell = this.world[wx]?.[wy];
      
      if (cell && cell.objects.length > 0) {
        // Slow down near objects
        player.velocity.x *= 0.9;
        player.velocity.y *= 0.9;
      }
    }
  }

  private updatePathfinding(): void {
    // Simple A* pathfinding for random subset of players
    const players = Array.from(this.players.values());
    const pathfindersThisTick = Math.ceil(players.length * 0.2); // 20% pathfind each tick
    
    for (let i = 0; i < pathfindersThisTick; i++) {
      const player = players[Math.floor(Math.random() * players.length)];
      
      // Pick random target
      const targetX = Math.floor(Math.random() * this.config.worldSize);
      const targetY = Math.floor(Math.random() * this.config.worldSize);
      
      // Run simplified A* (limited iterations)
      this.astar(
        Math.floor(player.position.x),
        Math.floor(player.position.y),
        targetX,
        targetY,
        100 // Max iterations
      );
      
      this.stats.pathfindOps++;
    }
  }

  private astar(startX: number, startY: number, endX: number, endY: number, maxIter: number): number[][] {
    const size = this.config.worldSize;
    const openSet: Array<{ x: number; y: number; f: number; g: number; parent: any }> = [];
    const closedSet = new Set<string>();
    
    const heuristic = (x1: number, y1: number, x2: number, y2: number) => {
      return Math.abs(x1 - x2) + Math.abs(y1 - y2);
    };
    
    openSet.push({
      x: startX,
      y: startY,
      f: heuristic(startX, startY, endX, endY),
      g: 0,
      parent: null
    });
    
    let iterations = 0;
    
    while (openSet.length > 0 && iterations < maxIter) {
      iterations++;
      
      // Find lowest f score
      openSet.sort((a, b) => a.f - b.f);
      const current = openSet.shift()!;
      
      if (current.x === endX && current.y === endY) {
        // Path found - reconstruct
        const path: number[][] = [];
        let node = current;
        while (node) {
          path.unshift([node.x, node.y]);
          node = node.parent;
        }
        return path;
      }
      
      closedSet.add(`${current.x},${current.y}`);
      
      // Check neighbors
      const neighbors = [
        { x: current.x - 1, y: current.y },
        { x: current.x + 1, y: current.y },
        { x: current.x, y: current.y - 1 },
        { x: current.x, y: current.y + 1 }
      ];
      
      for (const neighbor of neighbors) {
        const nx = ((neighbor.x % size) + size) % size;
        const ny = ((neighbor.y % size) + size) % size;
        
        if (closedSet.has(`${nx},${ny}`)) continue;
        
        const navWeight = this.world[nx]?.[ny]?.navWeight ?? 1;
        const g = current.g + navWeight;
        const h = heuristic(nx, ny, endX, endY);
        const f = g + h;
        
        const existing = openSet.find(n => n.x === nx && n.y === ny);
        if (existing) {
          if (g < existing.g) {
            existing.g = g;
            existing.f = f;
            existing.parent = current;
          }
        } else {
          openSet.push({ x: nx, y: ny, f, g, parent: current });
        }
      }
    }
    
    return []; // No path found
  }

  private updateGameLogic(): void {
    const players = Array.from(this.players.values());
    const viewDistance = 100;
    
    // Update visibility for each player
    for (const player of players) {
      player.visiblePlayers = [];
      
      for (const other of players) {
        if (other.id === player.id) continue;
        
        const dx = player.position.x - other.position.x;
        const dy = player.position.y - other.position.y;
        const distSq = dx * dx + dy * dy;
        
        if (distSq < viewDistance * viewDistance) {
          player.visiblePlayers.push(other.id);
          
          // Simulate combat - random damage
          if (Math.random() > 0.995 && other.health > 0) {
            const damage = Math.floor(Math.random() * 20) + 5;
            other.health = Math.max(0, other.health - damage);
            player.damageDealt += damage;
            other.lastHit = Date.now();
            
            if (other.health === 0) {
              player.kills++;
              // Respawn with delay (instant for simulation)
              other.health = 100;
              other.position.x = Math.random() * this.config.worldSize;
              other.position.y = Math.random() * this.config.worldSize;
            }
          }
        }
      }
    }
  }

  private serializeState(): void {
    // Simulate network serialization overhead
    const state = {
      gameId: this.gameId,
      tick: this.stats.tickCount,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        pos: [p.position.x, p.position.y, p.position.z],
        vel: [p.velocity.x, p.velocity.y],
        health: p.health,
        armor: p.armor,
        visible: p.visiblePlayers.length
      }))
    };
    
    // JSON serialize and immediately discard (simulates network send)
    const json = JSON.stringify(state);
    
    // Simulate compression overhead
    let checksum = 0;
    for (let i = 0; i < json.length; i++) {
      checksum = (checksum + json.charCodeAt(i)) & 0xFFFFFFFF;
    }
    
    // Touch memory buffer to prevent optimization
    if (this.memoryBuffer && this.stats.tickCount % 10 === 0) {
      const offset = (this.stats.tickCount * 4) % (this.memoryBuffer.length - 4);
      this.memoryBuffer.writeUInt32LE(checksum, offset);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSimulator(gameId: string, playerIds: string[]): BattleRoyaleSimulator {
  return new BattleRoyaleSimulator(gameId, playerIds);
}

export { getConfig as getSimulatorConfig };
