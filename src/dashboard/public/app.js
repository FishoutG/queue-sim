/**
 * Queue-Sim Dashboard Frontend
 * 
 * Real-time monitoring of matchmaking system state.
 */

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let ws = null;
let reconnectTimer = null;
const maxEvents = 50;
const events = [];

// ─────────────────────────────────────────────────────────────────────────────
// DOM Elements
// ─────────────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const elements = {
  connectionStatus: $("connection-status"),
  lastUpdate: $("last-update"),
  
  // Stats
  playersTotal: $("stat-players-total"),
  playersLobby: $("stat-players-lobby"),
  playersReady: $("stat-players-ready"),
  playersIngame: $("stat-players-ingame"),
  gamesRunning: $("stat-games-running"),
  gamesFinished: $("stat-games-finished"),
  sessionsTotal: $("stat-sessions-total"),
  sessionsIdle: $("stat-sessions-idle"),
  sessionsBusy: $("stat-sessions-busy"),
  queueReady: $("stat-queue-ready"),
  
  // Tables
  gamesTableBody: $("games-table-body"),
  playersTableBody: $("players-table-body"),
  sessionsTableBody: $("sessions-table-body"),
  
  // Filters
  gamesFilter: $("games-filter"),
  playersFilter: $("players-filter"),
  sessionsFilter: $("sessions-filter"),
  
  // Events
  eventsContainer: $("events-container"),
};

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Connection
// ─────────────────────────────────────────────────────────────────────────────

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log("WebSocket connected");
    elements.connectionStatus.textContent = "Connected";
    elements.connectionStatus.className = "status connected";
    clearTimeout(reconnectTimer);
  };
  
  ws.onclose = () => {
    console.log("WebSocket disconnected");
    elements.connectionStatus.textContent = "Disconnected";
    elements.connectionStatus.className = "status disconnected";
    scheduleReconnect();
  };
  
  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };
  
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (err) {
      console.error("Failed to parse message:", err);
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handling
// ─────────────────────────────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case "STATS_UPDATE":
      updateStats(msg.data);
      break;
    case "MATCH_FOUND":
      addEvent("MATCH_FOUND", `game=${shortId(msg.gameId)} session=${shortId(msg.sessionId)}`);
      refreshGames();
      break;
    case "MATCH_ENDED":
      addEvent("MATCH_ENDED", `game=${shortId(msg.gameId)} session=${shortId(msg.sessionId)}`);
      refreshGames();
      break;
  }
  
  elements.lastUpdate.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats Update
// ─────────────────────────────────────────────────────────────────────────────

function updateStats(stats) {
  // Players
  elements.playersTotal.textContent = stats.players.total;
  elements.playersLobby.textContent = stats.players.inLobby;
  elements.playersReady.textContent = stats.players.ready;
  elements.playersIngame.textContent = stats.players.inGame;
  
  // Games
  elements.gamesRunning.textContent = stats.games.running;
  elements.gamesFinished.textContent = stats.games.finished;
  
  // Sessions
  elements.sessionsTotal.textContent = stats.sessions.total;
  elements.sessionsIdle.textContent = stats.sessions.idle;
  elements.sessionsBusy.textContent = stats.sessions.busy;
  
  // Queue
  elements.queueReady.textContent = stats.queue.ready;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Fetching
// ─────────────────────────────────────────────────────────────────────────────

async function fetchGames() {
  const state = elements.gamesFilter.value;
  const url = state ? `/api/games?state=${state}` : "/api/games";
  const res = await fetch(url);
  return res.json();
}

async function fetchPlayers() {
  const state = elements.playersFilter.value;
  const url = state ? `/api/players?state=${state}&limit=100` : "/api/players?limit=100";
  const res = await fetch(url);
  return res.json();
}

async function fetchSessions() {
  const state = elements.sessionsFilter.value;
  const url = state ? `/api/sessions?state=${state}` : "/api/sessions";
  const res = await fetch(url);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Table Rendering
// ─────────────────────────────────────────────────────────────────────────────

async function refreshGames() {
  try {
    const { games } = await fetchGames();
    
    if (games.length === 0) {
      elements.gamesTableBody.innerHTML = '<tr><td colspan="6" class="loading">No games found</td></tr>';
      return;
    }
    
    elements.gamesTableBody.innerHTML = games.map(game => `
      <tr>
        <td class="id-cell">${shortId(game.id)}</td>
        <td class="id-cell">${shortId(game.sessionId)}</td>
        <td><span class="badge badge-${game.state.toLowerCase()}">${game.state}</span></td>
        <td>${game.playerCount}</td>
        <td class="time-cell ${game.timeLeftMs < 3000 ? 'urgent' : ''}">${formatTimeLeft(game.timeLeftMs)}</td>
        <td class="time-cell">${formatTime(game.startedAt)}</td>
      </tr>
    `).join("");
  } catch (err) {
    console.error("Failed to fetch games:", err);
    elements.gamesTableBody.innerHTML = '<tr><td colspan="6" class="loading">Error loading games</td></tr>';
  }
}

async function refreshPlayers() {
  try {
    const { players, total } = await fetchPlayers();
    
    if (players.length === 0) {
      elements.playersTableBody.innerHTML = '<tr><td colspan="5" class="loading">No players found</td></tr>';
      return;
    }
    
    elements.playersTableBody.innerHTML = players.map(player => `
      <tr>
        <td class="id-cell">${shortId(player.id)}</td>
        <td><span class="badge badge-${stateClass(player.state)}">${player.state}</span></td>
        <td class="id-cell">${player.gameId ? shortId(player.gameId) : "-"}</td>
        <td class="id-cell">${player.sessionId ? shortId(player.sessionId) : "-"}</td>
        <td class="time-cell">${formatTime(player.heartbeatAt)}</td>
      </tr>
    `).join("");
  } catch (err) {
    console.error("Failed to fetch players:", err);
    elements.playersTableBody.innerHTML = '<tr><td colspan="5" class="loading">Error loading players</td></tr>';
  }
}

async function refreshSessions() {
  try {
    const { sessions } = await fetchSessions();
    
    if (sessions.length === 0) {
      elements.sessionsTableBody.innerHTML = '<tr><td colspan="4" class="loading">No sessions found</td></tr>';
      return;
    }
    
    elements.sessionsTableBody.innerHTML = sessions.map(session => `
      <tr>
        <td class="id-cell">${shortId(session.id)}</td>
        <td><span class="badge badge-${session.state.toLowerCase()}">${session.state}</span></td>
        <td class="id-cell">${session.gameId ? shortId(session.gameId) : "-"}</td>
        <td class="time-cell">${formatTime(session.updatedAt)}</td>
      </tr>
    `).join("");
  } catch (err) {
    console.error("Failed to fetch sessions:", err);
    elements.sessionsTableBody.innerHTML = '<tr><td colspan="4" class="loading">Error loading sessions</td></tr>';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Log
// ─────────────────────────────────────────────────────────────────────────────

function addEvent(type, data) {
  const event = {
    time: new Date().toLocaleTimeString(),
    type,
    data,
  };
  
  events.unshift(event);
  if (events.length > maxEvents) {
    events.pop();
  }
  
  renderEvents();
}

function renderEvents() {
  elements.eventsContainer.innerHTML = events.map(event => `
    <div class="event">
      <span class="event-time">${event.time}</span>
      <span class="event-type ${event.type === 'MATCH_FOUND' ? 'match-found' : 'match-ended'}">${event.type}</span>
      <span class="event-data">${event.data}</span>
    </div>
  `).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function shortId(id) {
  if (!id) return "-";
  return id.substring(0, 8);
}

function formatTime(timestamp) {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleTimeString();
}

function formatTimeLeft(ms) {
  if (!ms || ms <= 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function stateClass(state) {
  switch (state) {
    case "IN_LOBBY": return "lobby";
    case "READY": return "ready";
    case "IN_GAME": return "ingame";
    default: return "lobby";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab Navigation
// ─────────────────────────────────────────────────────────────────────────────

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      
      // Update tab styles
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      
      // Update panel visibility
      panels.forEach(p => p.classList.remove("active"));
      document.getElementById(`${target}-panel`).classList.add("active");
      
      // Refresh data for the active panel
      switch (target) {
        case "games": refreshGames(); break;
        case "players": refreshPlayers(); break;
        case "sessions": refreshSessions(); break;
        case "infra": refreshInfra(); break;
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Listeners
// ─────────────────────────────────────────────────────────────────────────────

function setupEventListeners() {
  // Refresh buttons
  $("games-refresh").addEventListener("click", refreshGames);
  $("players-refresh").addEventListener("click", refreshPlayers);
  $("sessions-refresh").addEventListener("click", refreshSessions);
  
  // Filter changes
  elements.gamesFilter.addEventListener("change", refreshGames);
  elements.playersFilter.addEventListener("change", refreshPlayers);
  elements.sessionsFilter.addEventListener("change", refreshSessions);

  // Player control buttons
  $("spawn-btn").addEventListener("click", () => spawnPlayers(false));
  $("spawn-ready-btn").addEventListener("click", () => spawnPlayers(true));
  $("ready-all-btn").addEventListener("click", readyAllPlayers);
  $("clear-players-btn").addEventListener("click", clearAllPlayers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Player Controls
// ─────────────────────────────────────────────────────────────────────────────

async function spawnPlayers(readyUp) {
  const count = Number($("spawn-count").value) || 100;
  try {
    const res = await fetch("/api/players/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count, readyUp }),
    });
    const data = await res.json();
    if (data.success) {
      addEvent("SPAWN", `${data.count} players${readyUp ? " (ready)" : ""}`);
      refreshPlayers();
    } else {
      alert("Failed to spawn players: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    console.error("Spawn error:", err);
    alert("Failed to spawn players");
  }
}

async function readyAllPlayers() {
  try {
    const res = await fetch("/api/players/ready-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (data.success) {
      addEvent("READY_ALL", `${data.readied} players readied`);
      refreshPlayers();
    } else {
      alert("Failed to ready players: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    console.error("Ready all error:", err);
    alert("Failed to ready players");
  }
}

async function clearAllPlayers() {
  if (!confirm("Clear all players? This cannot be undone.")) return;
  try {
    const res = await fetch("/api/players/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (data.success) {
      addEvent("CLEAR", `${data.cleared} players cleared`);
      refreshPlayers();
    } else {
      alert("Failed to clear players: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    console.error("Clear error:", err);
    alert("Failed to clear players");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure (Proxmox)
// ─────────────────────────────────────────────────────────────────────────────

async function refreshInfra() {
  try {
    const res = await fetch("/api/infra");
    const data = await res.json();
    renderInfra(data);
  } catch (err) {
    console.error("Failed to load infra:", err);
  }
}

function renderInfra(data) {
  const disabledEl = document.getElementById("infra-disabled");
  const contentEl = document.getElementById("infra-content");
  
  if (!data.enabled) {
    disabledEl.style.display = "block";
    contentEl.style.display = "none";
    return;
  }
  
  disabledEl.style.display = "none";
  contentEl.style.display = "block";
  
  // Render nodes
  const nodesBody = document.getElementById("nodes-table-body");
  if (data.nodes.length === 0) {
    nodesBody.innerHTML = '<tr><td colspan="5" class="empty">No nodes found</td></tr>';
  } else {
    nodesBody.innerHTML = data.nodes.map(node => `
      <tr>
        <td>${node.node}</td>
        <td><span class="badge badge-${node.status === 'online' ? 'running' : 'finished'}">${node.status}</span></td>
        <td>${node.cpu !== undefined ? (node.cpu * 100).toFixed(1) + '%' : '-'}</td>
        <td>${node.mem && node.maxmem ? formatBytes(node.mem) + ' / ' + formatBytes(node.maxmem) : '-'}</td>
        <td>${node.uptime ? formatUptime(node.uptime) : '-'}</td>
      </tr>
    `).join('');
  }
  
  // Render VMs
  const vmsBody = document.getElementById("vms-table-body");
  if (data.vms.length === 0) {
    vmsBody.innerHTML = '<tr><td colspan="6" class="empty">No VMs found</td></tr>';
  } else {
    vmsBody.innerHTML = data.vms.map(vm => `
      <tr>
        <td>${vm.vmid}</td>
        <td>${vm.name || '-'}</td>
        <td>${vm.node}</td>
        <td><span class="badge badge-${vm.status === 'running' ? 'running' : 'finished'}">${vm.status}</span></td>
        <td>${vm.cpu !== undefined ? (vm.cpu * 100).toFixed(1) + '%' : '-'}</td>
        <td>${vm.mem && vm.maxmem ? formatBytes(vm.mem) + ' / ' + formatBytes(vm.maxmem) : '-'}</td>
      </tr>
    `).join('');
  }
  
  // Render containers
  const containersBody = document.getElementById("containers-table-body");
  if (data.containers.length === 0) {
    containersBody.innerHTML = '<tr><td colspan="6" class="empty">No containers found</td></tr>';
  } else {
    containersBody.innerHTML = data.containers.map(ct => `
      <tr>
        <td>${ct.vmid}</td>
        <td>${ct.name || '-'}</td>
        <td>${ct.node}</td>
        <td><span class="badge badge-${ct.status === 'running' ? 'running' : 'finished'}">${ct.status}</span></td>
        <td>${ct.cpu !== undefined ? (ct.cpu * 100).toFixed(1) + '%' : '-'}</td>
        <td>${ct.mem && ct.maxmem ? formatBytes(ct.mem) + ' / ' + formatBytes(ct.maxmem) : '-'}</td>
      </tr>
    `).join('');
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-refresh
// ─────────────────────────────────────────────────────────────────────────────

function startAutoRefresh() {
  // Refresh active panel every 0.25 seconds
  setInterval(() => {
    const activeTab = document.querySelector(".tab.active");
    if (!activeTab) return;
    
    const target = activeTab.dataset.tab;
    switch (target) {
      case "games": refreshGames(); break;
      case "players": refreshPlayers(); break;
      case "sessions": refreshSessions(); break;
      case "infra": refreshInfra(); break;
    }
  }, 250);
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialize
// ─────────────────────────────────────────────────────────────────────────────

function init() {
  setupTabs();
  setupEventListeners();
  connect();
  
  // Initial data load
  refreshGames();
  
  // Start auto-refresh
  startAutoRefresh();
}

// Start when DOM is ready
document.addEventListener("DOMContentLoaded", init);
