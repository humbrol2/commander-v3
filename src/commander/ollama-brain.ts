/**
 * Ollama Brain - local LLM via Ollama (Qwen3 8B default).
 * Uses ollama-ai-provider + Vercel AI SDK.
 */

import { ollama } from "ollama-ai-provider";
import { LlmBrain } from "./llm-brain";
import type { LanguageModel } from "ai";

export interface OllamaBrainConfig {
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export function createOllamaBrain(config: OllamaBrainConfig = {}): LlmBrain {
  const modelName = config.model ?? "qwen3:8b";
  // ollama-ai-provider exports LanguageModelV1; ai v6 expects V2/V3.
  // Runtime-compatible — cast until provider updates.
  const model = ollama(modelName, {
    structuredOutputs: false,
  }) as unknown as LanguageModel;

  return new LlmBrain({
    name: `ollama/${modelName}`,
    model,
    maxTokens: config.maxTokens ?? 1024,
    timeoutMs: config.timeoutMs ?? 30_000, // Ollama can be slow
  });
}
