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
  // Skip table re-render while metrics dropdown is open
  // This prevents the dropdown from being destroyed during auto-refresh
  if (currentDropdown) return;
  
  const disabledEl = document.getElementById("infra-disabled");
  const contentEl = document.getElementById("infra-content");
  
  if (!data.enabled) {
    disabledEl.style.display = "block";
    contentEl.style.display = "none";
    return;
  }
  
  disabledEl.style.display = "none";
  contentEl.style.display = "block";
  
  // Sort data for stable display
  const sortedNodes = [...data.nodes].sort((a, b) => (a.node || '').localeCompare(b.node || ''));
  const sortedVMs = [...data.vms].sort((a, b) => (a.vmid || 0) - (b.vmid || 0));
  const sortedContainers = [...data.containers].sort((a, b) => (a.vmid || 0) - (b.vmid || 0));
  
  // Render nodes
  const nodesBody = document.getElementById("nodes-table-body");
  if (sortedNodes.length === 0) {
    nodesBody.innerHTML = '<tr><td colspan="5" class="empty">No nodes found</td></tr>';
  } else {
    nodesBody.innerHTML = sortedNodes.map(node => `
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
  if (sortedVMs.length === 0) {
    vmsBody.innerHTML = '<tr><td colspan="6" class="empty">No VMs found</td></tr>';
  } else {
    vmsBody.innerHTML = sortedVMs.map(vm => `
      <tr class="clickable" data-type="qemu" data-node="${vm.node}" data-vmid="${vm.vmid}" data-name="${vm.name || 'VM ' + vm.vmid}">
        <td>${vm.vmid}</td>
        <td>${vm.name || '-'}</td>
        <td>${vm.node}</td>
        <td><span class="badge badge-${vm.status === 'running' ? 'running' : 'finished'}">${vm.status}</span></td>
        <td>${vm.cpu !== undefined ? (vm.cpu * 100).toFixed(1) + '%' : '-'}</td>
        <td>${vm.mem && vm.maxmem ? formatBytes(vm.mem) + ' / ' + formatBytes(vm.maxmem) : '-'}</td>
      </tr>
    `).join('');
    
    // Add click handlers
    vmsBody.querySelectorAll('tr.clickable').forEach(row => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMetricsDropdown(
          row,
          row.dataset.type,
          row.dataset.node,
          row.dataset.vmid,
          row.dataset.name
        );
      });
    });
  }
  
  // Render containers
  const containersBody = document.getElementById("containers-table-body");
  if (sortedContainers.length === 0) {
    containersBody.innerHTML = '<tr><td colspan="6" class="empty">No containers found</td></tr>';
  } else {
    containersBody.innerHTML = sortedContainers.map(ct => `
      <tr class="clickable" data-type="lxc" data-node="${ct.node}" data-vmid="${ct.vmid}" data-name="${ct.name || 'CT ' + ct.vmid}">
        <td>${ct.vmid}</td>
        <td>${ct.name || '-'}</td>
        <td>${ct.node}</td>
        <td><span class="badge badge-${ct.status === 'running' ? 'running' : 'finished'}">${ct.status}</span></td>
        <td>${ct.cpu !== undefined ? (ct.cpu * 100).toFixed(1) + '%' : '-'}</td>
        <td>${ct.mem && ct.maxmem ? formatBytes(ct.mem) + ' / ' + formatBytes(ct.maxmem) : '-'}</td>
      </tr>
    `).join('');
    
    // Add click handlers
    containersBody.querySelectorAll('tr.clickable').forEach(row => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMetricsDropdown(
          row,
          row.dataset.type,
          row.dataset.node,
          row.dataset.vmid,
          row.dataset.name
        );
      });
    });
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
// VM Metrics Dropdown & Charts
// 
// Inline expandable metrics panel that appears below VM/container rows.
// Features:
// - Click a VM/container row to expand metrics dropdown below it
// - Click again to collapse
// - Live polling every 500ms for real-time updates
// - 4 charts: CPU, Memory, Disk I/O, Network I/O
// - Timeframe selector: Hour, Day, Week, Month, Year
// - Pauses table refresh while dropdown is open to preserve state
// ─────────────────────────────────────────────────────────────────────────────

// Current dropdown state - tracks the open dropdown, its charts, and polling interval
let currentDropdown = null; // { row, element, target, charts, pollInterval }

/**
 * Toggle metrics dropdown for a VM or container row
 * @param {HTMLElement} clickedRow - The table row that was clicked
 * @param {string} type - 'qemu' for VMs, 'lxc' for containers
 * @param {string} node - Proxmox node name
 * @param {string} vmid - VM/container ID
 * @param {string} name - Display name
 */
function toggleMetricsDropdown(clickedRow, type, node, vmid, name) {
  // If clicking the same row, close it (toggle behavior)
  if (currentDropdown && currentDropdown.target.vmid === vmid && currentDropdown.target.node === node) {
    closeMetricsDropdown();
    return;
  }
  
  // Close any existing dropdown before opening a new one
  closeMetricsDropdown();
  
  // Clone the dropdown template from the HTML
  const template = document.getElementById('metrics-dropdown-template');
  if (!template) {
    console.error('Metrics dropdown template not found');
    return;
  }
  
  const dropdownRow = template.content.cloneNode(true).querySelector('tr');
  if (!dropdownRow) {
    console.error('Could not clone dropdown row from template');
    return;
  }
  
  // Insert the dropdown row directly after the clicked row
  clickedRow.classList.add('expanded');
  clickedRow.after(dropdownRow);
  
  // Get reference to the actually inserted DOM element
  const insertedRow = clickedRow.nextElementSibling;
  if (!insertedRow) {
    console.error('Failed to get inserted row');
    return;
  }
  
  // Set the dropdown title to show which VM/container
  insertedRow.querySelector('.metrics-dropdown-title').textContent = `${name} Metrics`;
  
  // Store all dropdown state for later reference
  currentDropdown = {
    row: clickedRow,           // Original clicked row (to remove 'expanded' class later)
    element: insertedRow,      // The dropdown row element
    target: { type, node, vmid, name }, // VM/container info for API calls
    charts: { cpu: null, mem: null, disk: null, net: null }, // Chart.js instances
    pollInterval: null         // Interval ID for 500ms polling
  };
  
  // Setup timeframe dropdown change handler
  const timeframeSelect = insertedRow.querySelector('.metrics-timeframe');
  timeframeSelect.addEventListener('change', () => loadDropdownMetrics());
  
  // Render placeholder charts immediately so user sees the UI
  renderDropdownCharts([], 'hour');
  
  // Load actual metrics data
  loadDropdownMetrics();
  
  // Start live polling - update charts every 500ms
  currentDropdown.pollInterval = setInterval(() => loadDropdownMetrics(), 500);
}

/**
 * Close the currently open metrics dropdown
 * Stops polling, destroys charts, and removes the dropdown row
 */
function closeMetricsDropdown() {
  if (!currentDropdown) return;
  
  // Stop the 500ms polling interval
  if (currentDropdown.pollInterval) {
    clearInterval(currentDropdown.pollInterval);
  }
  
  // Destroy all Chart.js instances to free memory
  Object.values(currentDropdown.charts).forEach(chart => chart?.destroy());
  
  // Remove 'expanded' highlight from the original row
  currentDropdown.row.classList.remove('expanded');
  
  // Remove the dropdown row from the DOM
  currentDropdown.element.remove();
  
  currentDropdown = null;
}

/**
 * Fetch metrics data from the Proxmox API and render charts
 * Called on initial load and every 500ms for live updates
 */
async function loadDropdownMetrics() {
  if (!currentDropdown) return;
  
  const { type, node, vmid } = currentDropdown.target;
  const timeframe = currentDropdown.element.querySelector('.metrics-timeframe').value;
  
  try {
    // Fetch RRD (round-robin database) metrics from Proxmox via our API
    const res = await fetch(`/api/infra/metrics/${type}/${node}/${vmid}?timeframe=${timeframe}`);
    const data = await res.json();
    
    if (data.error) {
      console.error('Metrics error:', data.error);
      return;
    }
    
    // Update the charts with new data
    renderDropdownCharts(data.data, timeframe);
  } catch (err) {
    console.error('Failed to load metrics:', err);
  }
}

/**
 * Render the 4 metrics charts (CPU, Memory, Disk I/O, Network I/O)
 * Uses Chart.js for visualization
 * @param {Array} data - Array of RRD data points from Proxmox
 * @param {string} timeframe - 'hour', 'day', 'week', 'month', or 'year'
 */
function renderDropdownCharts(data, timeframe) {
  if (!currentDropdown) return;
  
  const dropdown = currentDropdown.element;
  const charts = currentDropdown.charts;
  
  // Process data or create placeholder if empty
  let validData = [];
  let labels = [];
  
  if (data && data.length > 0) {
    // Filter entries with timestamps and sort chronologically
    validData = data.filter(d => d.time).sort((a, b) => a.time - b.time);
    
    // Format time labels based on timeframe
    labels = validData.map(d => {
      const date = new Date(d.time * 1000);
      if (timeframe === 'hour') {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else if (timeframe === 'day') {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
    });
  }
  
  // If no data available, create placeholder with 60 zero-value points
  // This ensures charts display a flat line instead of an empty box
  if (validData.length === 0) {
    const now = Date.now();
    for (let i = 59; i >= 0; i--) {
      validData.push({ time: (now - i * 60000) / 1000, cpu: 0, mem: 0 });
    }
    labels = validData.map(d => {
      const date = new Date(d.time * 1000);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
  }
  
  // Shared Chart.js options for all charts
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false, // Disable animation for 500ms polling performance
    plugins: { legend: { display: false } },
    scales: {
      x: {
        display: false, // Hide x-axis labels for compact view
        grid: { display: false }
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.05)' },
        ticks: { color: '#8b949e', font: { size: 9 }, maxTicksLimit: 3 },
        beginAtZero: true
      }
    }
  };
  
  // CPU Usage Chart (percentage 0-100%)
  const cpuCanvas = dropdown.querySelector('.chart-cpu');
  if (cpuCanvas) {
    charts.cpu?.destroy(); // Destroy previous chart instance
    charts.cpu = new Chart(cpuCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: validData.map(d => d.cpu !== undefined ? (d.cpu * 100) : 0),
          borderColor: '#58a6ff',
          backgroundColor: 'rgba(88, 166, 255, 0.2)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5
        }]
      },
      options: {
        ...chartOptions,
        scales: {
          ...chartOptions.scales,
          y: { ...chartOptions.scales.y, max: 100, ticks: { ...chartOptions.scales.y.ticks, callback: v => v + '%' } }
        }
      }
    });
  }
  
  // Memory Usage Chart (displayed in GB)
  const memCanvas = dropdown.querySelector('.chart-mem');
  if (memCanvas) {
    charts.mem?.destroy();
    charts.mem = new Chart(memCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: validData.map(d => d.mem ? d.mem / (1024 * 1024 * 1024) : 0),
          borderColor: '#3fb950',
          backgroundColor: 'rgba(63, 185, 80, 0.2)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5
        }]
      },
      options: {
        ...chartOptions,
        scales: {
          ...chartOptions.scales,
          y: { ...chartOptions.scales.y, ticks: { ...chartOptions.scales.y.ticks, callback: v => v.toFixed(1) + 'G' } }
        }
      }
    });
  }
  
  // Disk I/O Chart (Read in blue, Write in red - MB/s)
  const diskCanvas = dropdown.querySelector('.chart-disk');
  if (diskCanvas) {
    charts.disk?.destroy();
    charts.disk = new Chart(diskCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'R',
            data: validData.map(d => d.diskread ? d.diskread / (1024 * 1024) : 0),
            borderColor: '#58a6ff',
            backgroundColor: 'transparent',
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5
          },
          {
            label: 'W',
            data: validData.map(d => d.diskwrite ? d.diskwrite / (1024 * 1024) : 0),
            borderColor: '#f85149',
            backgroundColor: 'transparent',
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5
          }
        ]
      },
      options: {
        ...chartOptions,
        plugins: { legend: { display: true, position: 'top', labels: { color: '#8b949e', boxWidth: 8, font: { size: 9 } } } }
      }
    });
  }
  
  // Network I/O Chart (In in green, Out in purple - MB/s)
  const netCanvas = dropdown.querySelector('.chart-net');
  if (netCanvas) {
    charts.net?.destroy();
    charts.net = new Chart(netCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'In',
            data: validData.map(d => d.netin ? d.netin / (1024 * 1024) : 0),
            borderColor: '#3fb950',
            backgroundColor: 'transparent',
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5
          },
          {
            label: 'Out',
            data: validData.map(d => d.netout ? d.netout / (1024 * 1024) : 0),
            borderColor: '#a371f7',
            backgroundColor: 'transparent',
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5
          }
        ]
      },
      options: {
        ...chartOptions,
        plugins: { legend: { display: true, position: 'top', labels: { color: '#8b949e', boxWidth: 8, font: { size: 9 } } } }
      }
    });
  }
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
