import { startNodeService } from "./node-server.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3000");
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
const allowedHostnames = process.env.ALLOWED_HOSTS?.split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

const service = await startNodeService({
  host,
  port,
  ...(publicBaseUrl === undefined ? {} : { public_base_url: publicBaseUrl }),
  ...(allowedHostnames === undefined ? {} : { allowed_hostnames: allowedHostnames }),
});

process.stdout.write(`DeliverCheck listening on ${service.origin}\n`);

async function stop(): Promise<void> {
  await service.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
