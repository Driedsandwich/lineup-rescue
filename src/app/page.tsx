import RescueForm from "./rescue-form";
import { providerStatus } from "../lib/status";

export const dynamic = "force-dynamic";
export default function Home() {
  return <main id="main">
    <header className="masthead"><a className="brand" href="#main"><span className="brand-mark" aria-hidden="true">lr<span>↗</span></span><span>Lineup Rescue<small>FESTIVAL NIGHT OPERATIONS</small></span></a><span className="chip neutral">Decision support · no bookings</span></header>
    <RescueForm initialStatus={providerStatus()} />
    <footer><span>Lineup Rescue / Night operations</span><span>Aggregate taste evidence. Human decisions.</span></footer>
  </main>;
}
