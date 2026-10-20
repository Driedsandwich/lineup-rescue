import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Encore Rescue — rebuild the night",
  description: "Compare a booker's feasible replacement acts using aggregate taste evidence, then draft the operational response.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip" href="#main">Skip to content</a>{children}</body></html>;
}
