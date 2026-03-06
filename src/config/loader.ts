/**
 * TOML config loader with Zod validation.
 */

import { readFileSync } from "fs";
import TOML from "toml";
import { AppConfigSchema, type AppConfig } from "./schema";

export function loadConfig(path = "config.toml"): AppConfig {
  const raw = readFileSync(path, "utf-8");
  const parsed = TOML.parse(raw);
  return AppConfigSchema.parse(parsed);
}
