import "server-only";
import { QlooClient } from "./client";
import { MockQloo } from "./mock";

export function qlooMode(): "mock" | "live" {
  return !process.env.QLOO_API_KEY || process.env.QLOO_MODE === "mock" ? "mock" : "live";
}
export function createQloo() {
  return qlooMode() === "mock" ? new MockQloo() : new QlooClient(process.env.QLOO_API_KEY!, process.env.QLOO_BASE_URL);
}
