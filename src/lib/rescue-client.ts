import type { RescueRequest, RescueResponse, Scenario } from "./contracts";
import { recoveryAdvice, rescuePayload } from "./presentation";

export async function requestRescue(mode: RescueRequest["mode"], scenario: Scenario, resolutions: Record<string, string>, transport: typeof fetch = fetch): Promise<RescueResponse> {
  let response: Response;
  try {
    response = await transport("/api/rescue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rescuePayload(mode, scenario, resolutions)) });
  } catch { throw new Error("Connection lost. Check your connection and retry. Your scenario is still here."); }
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`Unexpected server response (${response.status}). ${recoveryAdvice(response.status, response.headers.get("Retry-After"))}`); }
  if (!response.ok) {
    const issues = Array.isArray(body.issues) ? body.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join("; ") : "";
    throw new Error(`${body.message ?? "Request failed"} (${response.status}). ${issues} ${recoveryAdvice(response.status, response.headers.get("Retry-After"), body.error)}`);
  }
  return body as RescueResponse;
}
