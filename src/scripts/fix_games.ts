import Redis from "ioredis";
const r = new Redis();

(async () => {
  const now = Date.now();
  const gameKeys = await r.keys("game:*");
  for (const k of gameKeys) {
    if (!k.includes(":players")) {
      const state = await r.hget(k, "state");
      if (state === "RUNNING") {
        await r.hset(k, "end_at", now.toString());
        console.log("Fixed:", k);
      }
    }
  }
  r.disconnect();
})();
