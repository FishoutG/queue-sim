import WebSocket from "ws";

const URL = process.env.URL ?? "ws://127.0.0.1:3000";
const READY_UP = (process.env.READY_UP ?? "true").toLowerCase() !== "false";
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 5000);

// Serialize and send client messages.
function send(ws: WebSocket, msg: any) {
  ws.send(JSON.stringify(msg));
}

async function main() {
  const ws = new WebSocket(URL);

  ws.on("open", () => {
    console.log(`Connected to ${URL}`);
    send(ws, { type: "HELLO" });

    if (READY_UP) {
      send(ws, { type: "READY_UP" });
      console.log("Sent READY_UP");
    }

    setInterval(() => send(ws, { type: "HEARTBEAT" }), HEARTBEAT_MS);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("Server message:", msg);
    } catch {
      console.log("Server message (raw):", raw.toString());
    }
  });

  ws.on("close", () => {
    console.log("Disconnected");
  });

  ws.on("error", (e) => console.error("WS error:", e));
}

main().catch(console.error);
