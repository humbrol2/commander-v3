/**
 * Claude Brain - Anthropic Claude Haiku via @ai-sdk/anthropic.
 * High quality cloud fallback.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { LlmBrain } from "./llm-brain";

export interface ClaudeBrainConfig {
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  promptFile?: string;
}

export function createClaudeBrain(config: ClaudeBrainConfig = {}): LlmBrain {
  const modelName = config.model ?? "claude-3-5-haiku-latest";
  const model = anthropic(modelName);

  return new LlmBrain({
    name: `claude/${modelName}`,
    model,
    maxTokens: config.maxTokens ?? 1024,
    timeoutMs: config.timeoutMs ?? 15_000,
    promptFile: config.promptFile,
  });
}
