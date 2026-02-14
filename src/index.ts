import Redis from "ioredis";

// Simple Redis smoke test for local connectivity.
async function main() {
  // Connect to Redis using defaults expected in local dev.
  const redis = new Redis({ host: "127.0.0.1", port: 6379 });

  // Surface connection errors early.
  redis.on("error", (err) => console.error("Redis error:", err));

  // Verify connectivity and basic read/write behavior.
  console.log("Redis ping:", await redis.ping());
  await redis.set("hello", "world");
  console.log("Redis get hello:", await redis.get("hello"));

  // Close the connection cleanly.
  await redis.quit();
}

// Fail fast on any unexpected error.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
