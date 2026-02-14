import WebSocket from "ws";

const COUNT = Number(process.env.COUNT ?? 100);
const URL = process.env.URL ?? "ws://127.0.0.1:3000";

// Helper to serialize and send client messages.
function send(ws: WebSocket, msg: any) {
  ws.send(JSON.stringify(msg));
}

// Spawn COUNT websocket clients that immediately READY_UP.
async function main() {
  let opened = 0;

  for (let i = 0; i < COUNT; i++) {
    const ws = new WebSocket(URL);

    ws.on("open", () => {
      opened++;
      // Identify then mark ready for matchmaking.
      send(ws, { type: "HELLO" });
      send(ws, { type: "READY_UP" });

      // Keep alive so the gateway updates heartbeat.
      setInterval(() => send(ws, { type: "HEARTBEAT" }), 5000);

      if (opened % 25 === 0) console.log(`Opened ${opened}/${COUNT}`);
    });

    ws.on("error", (e) => console.error("WS error:", e));
  }
}

// Print any unexpected error.
main().catch(console.error);
