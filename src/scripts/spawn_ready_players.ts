import WebSocket from "ws";

const COUNT = Number(process.env.COUNT ?? 100);
const URL = process.env.URL ?? "ws://127.0.0.1:3000";

function send(ws: WebSocket, msg: any) {
  ws.send(JSON.stringify(msg));
}

async function main() {
  let opened = 0;

  for (let i = 0; i < COUNT; i++) {
    const ws = new WebSocket(URL);

    ws.on("open", () => {
      opened++;
      send(ws, { type: "HELLO" });
      send(ws, { type: "READY_UP" });

      // Keep alive
      setInterval(() => send(ws, { type: "HEARTBEAT" }), 5000);

      if (opened % 25 === 0) console.log(`Opened ${opened}/${COUNT}`);
    });

    ws.on("error", (e) => console.error("WS error:", e));
  }
}

main().catch(console.error);
