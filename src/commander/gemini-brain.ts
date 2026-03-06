/**
 * Gemini Brain - Google Gemini Flash via @ai-sdk/google.
 * Fast, cheap cloud fallback.
 */

import { google } from "@ai-sdk/google";
import { LlmBrain } from "./llm-brain";

export interface GeminiBrainConfig {
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export function createGeminiBrain(config: GeminiBrainConfig = {}): LlmBrain {
  const modelName = config.model ?? "gemini-2.0-flash";
  const model = google(modelName);

  return new LlmBrain({
    name: `gemini/${modelName}`,
    model,
    maxTokens: config.maxTokens ?? 1024,
    timeoutMs: config.timeoutMs ?? 15_000,
  });
}
