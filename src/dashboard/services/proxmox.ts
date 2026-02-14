/**
 * Proxmox API Client (Future Integration)
 * 
 * This service will provide access to Proxmox VE cluster stats including:
 * - Node status (CPU, memory, uptime)
 * - VM list and status
 * - Container list and status
 * - Storage usage
 * 
 * Configuration via environment variables:
 *   PROXMOX_HOST      - Proxmox API URL (e.g., https://proxmox.local:8006)
 *   PROXMOX_USER      - API user (e.g., api@pam)
 *   PROXMOX_TOKEN_ID  - API token ID
 *   PROXMOX_TOKEN_SECRET - API token secret
 */

// Allow self-signed certificates for Proxmox (common in homelab setups)
// In production, use proper certificates instead
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ProxmoxConfig {
  host: string;
  user: string;
  tokenId: string;
  tokenSecret: string;
}

export interface ProxmoxNode {
  node: string;
  status: "online" | "offline";
  cpu: number;        // 0-1 (percentage as decimal)
  maxcpu: number;     // Number of CPUs
  mem: number;        // Used memory in bytes
  maxmem: number;     // Total memory in bytes
  uptime: number;     // Seconds
}

export interface ProxmoxVM {
  vmid: number;
  name: string;
  node: string;
  status: "running" | "stopped" | "paused";
  cpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
}

export interface ProxmoxContainer {
  vmid: number;
  name: string;
  node: string;
  status: "running" | "stopped";
  cpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
}

export interface ProxmoxStats {
  enabled: boolean;
  nodes: ProxmoxNode[];
  vms: ProxmoxVM[];
  containers: ProxmoxContainer[];
  lastUpdated: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

function getConfig(): ProxmoxConfig | null {
  const host = process.env.PROXMOX_HOST || "https://10.10.10.10:8006";
  const user = process.env.PROXMOX_USER || "opnvdi@pam";
  const tokenId = process.env.PROXMOX_TOKEN_ID || "UI2";
  const tokenSecret = process.env.PROXMOX_TOKEN_SECRET || "33f7e112-ab02-42d5-9980-aa76eea2535d";

  if (!host || !user || !tokenId || !tokenSecret) {
    return null;
  }

  return { host, user, tokenId, tokenSecret };
}

// ─────────────────────────────────────────────────────────────────────────────
// API Client
// ─────────────────────────────────────────────────────────────────────────────

class ProxmoxClient {
  private config: ProxmoxConfig;

  constructor(config: ProxmoxConfig) {
    this.config = config;
  }

  /**
   * Build authorization header for Proxmox API
   */
  private getAuthHeader(): string {
    return `PVEAPIToken=${this.config.user}!${this.config.tokenId}=${this.config.tokenSecret}`;
  }

  /**
   * Make authenticated request to Proxmox API
   */
  private async request<T>(path: string): Promise<T> {
    const url = `${this.config.host}/api2/json${path}`;
    
    const response = await fetch(url, {
      headers: {
        Authorization: this.getAuthHeader(),
      },
      // Skip SSL verification for self-signed certs (common in homelab)
      // In production, use proper certificates
    });

    if (!response.ok) {
      throw new Error(`Proxmox API error: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    return json.data as T;
  }

  /**
   * Get list of nodes in the cluster
   */
  async getNodes(): Promise<ProxmoxNode[]> {
    return this.request<ProxmoxNode[]>("/nodes");
  }

  /**
   * Get detailed status for a specific node
   */
  async getNodeStatus(node: string): Promise<ProxmoxNode> {
    return this.request<ProxmoxNode>(`/nodes/${node}/status`);
  }

  /**
   * Get VMs on a specific node
   */
  async getVMs(node: string): Promise<ProxmoxVM[]> {
    const vms = await this.request<ProxmoxVM[]>(`/nodes/${node}/qemu`);
    return vms.map(vm => ({ ...vm, node }));
  }

  /**
   * Get containers on a specific node
   */
  async getContainers(node: string): Promise<ProxmoxContainer[]> {
    const containers = await this.request<ProxmoxContainer[]>(`/nodes/${node}/lxc`);
    return containers.map(ct => ({ ...ct, node }));
  }

  /**
   * Get all stats for the cluster
   */
  async getAllStats(): Promise<ProxmoxStats> {
    const nodes = await this.getNodes();
    const vms: ProxmoxVM[] = [];
    const containers: ProxmoxContainer[] = [];

    for (const node of nodes) {
      if (node.status === "online") {
        const nodeVMs = await this.getVMs(node.node);
        const nodeCTs = await this.getContainers(node.node);
        vms.push(...nodeVMs);
        containers.push(...nodeCTs);
      }
    }

    return {
      enabled: true,
      nodes,
      vms,
      containers,
      lastUpdated: Date.now(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

let client: ProxmoxClient | null = null;

/**
 * Check if Proxmox integration is enabled
 */
export function isProxmoxEnabled(): boolean {
  return getConfig() !== null;
}

/**
 * Get Proxmox client instance (singleton)
 */
export function getProxmoxClient(): ProxmoxClient | null {
  if (client) return client;

  const config = getConfig();
  if (!config) return null;

  client = new ProxmoxClient(config);
  return client;
}

/**
 * Get Proxmox stats (or disabled status if not configured)
 */
export async function getProxmoxStats(): Promise<ProxmoxStats> {
  const proxmox = getProxmoxClient();
  
  if (!proxmox) {
    return {
      enabled: false,
      nodes: [],
      vms: [],
      containers: [],
      lastUpdated: Date.now(),
    };
  }

  try {
    return await proxmox.getAllStats();
  } catch (err) {
    console.error("Error fetching Proxmox stats:", err);
    return {
      enabled: true,
      nodes: [],
      vms: [],
      containers: [],
      lastUpdated: Date.now(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Example
// ─────────────────────────────────────────────────────────────────────────────

/*
To enable Proxmox integration, set these environment variables:

export PROXMOX_HOST=https://proxmox.local:8006
export PROXMOX_USER=api@pam
export PROXMOX_TOKEN_ID=dashboard
export PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

Then the dashboard will automatically show infrastructure stats.
*/
