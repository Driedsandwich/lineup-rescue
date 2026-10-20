import { providerStatus } from "../../../lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(providerStatus(), { headers: { "Cache-Control": "no-store" } });
}
