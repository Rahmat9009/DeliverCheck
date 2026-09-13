import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateLiveConfig } from "./config.js";
import type { LiveArenaConfig, ProductMarketplace, RankingAdapter } from "./types.js";

const MAX_CONFIG_BYTES = 64 * 1024;

export interface OrganizerIntegrations {
  marketplace: ProductMarketplace;
  ranking: RankingAdapter;
}

interface IntegrationModule {
  createArenaIntegrations?: (config: LiveArenaConfig) => Promise<OrganizerIntegrations> | OrganizerIntegrations;
}

export async function loadLiveArenaConfig(path: string): Promise<LiveArenaConfig> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error("The Arena configuration file is missing or exceeds 64 KiB.");
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("The Arena configuration file is not valid JSON."); }
  return validateLiveConfig(parsed as LiveArenaConfig);
}

export async function loadOrganizerIntegrations(modulePath: string, config: LiveArenaConfig, repository: string): Promise<OrganizerIntegrations> {
  const resolved = resolve(repository, modulePath);
  const root = `${resolve(repository)}/`;
  if (!resolved.startsWith(root)) throw new Error("The organizer integration module must be inside the repository.");
  const module = await import(pathToFileURL(resolved).href) as IntegrationModule;
  if (typeof module.createArenaIntegrations !== "function") throw new Error("The organizer integration module does not export createArenaIntegrations.");
  const integrations = await module.createArenaIntegrations(config);
  if (integrations.marketplace.adapter_id !== config.marketplace.adapter || integrations.marketplace.protocol_version !== config.marketplace.protocol_version) throw new Error("The configured marketplace adapter identity does not match its module.");
  if (integrations.ranking.method !== config.ranking_method.adapter || integrations.ranking.idempotent !== true) throw new Error("The configured ranking adapter identity does not match its module.");
  return integrations;
}
