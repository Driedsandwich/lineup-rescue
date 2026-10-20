import RescueForm from "./rescue-form";
import { qlooMode } from "../lib/qloo";
import { llmMode } from "../lib/agent/plans";

export const dynamic = "force-dynamic";
export default function Home() {
  return <main id="main">
    <header><p className="eyebrow">Festival operations · decision support</p><h1>Encore Rescue</h1><p>One cancellation. A feasible phone list. Rebuild the night with audience evidence.</p></header>
    <RescueForm sampleData={qlooMode() === "mock"} mockPlanner={llmMode() === "mock"} />
  </main>;
}
