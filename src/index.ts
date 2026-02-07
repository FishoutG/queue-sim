import Redis from "ioredis";

async function main() {
  const redis = new Redis({ host: "127.0.0.1", port: 6379 });

  redis.on("error", (err) => console.error("Redis error:", err));

  console.log("Redis ping:", await redis.ping());
  await redis.set("hello", "world");
  console.log("Redis get hello:", await redis.get("hello"));

  await redis.quit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
