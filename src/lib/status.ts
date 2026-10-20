import "server-only";
import { qlooMode } from "./qloo";
import { llmMode } from "./agent/plans";

export function providerStatus() {
  return { qloo: qlooMode(), llm: llmMode() };
}
