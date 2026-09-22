import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { resolveConfig } from "../lib/config";

/**
 * The configuration (Factory address, fee, RPC, active network) is read from the
 * server at request time. Without this, Next.js would inline `NEXT_PUBLIC_*`
 * values at build time and the operator would need a full image rebuild just to
 * paste in a newly deployed Factory address.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Base Token Creator",
  description: "Create a standard ERC-20 token on Base Sepolia. Non-custodial.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // resolveConfig() copies only the specific keys it needs, so no secret from
  // process.env can end up in the serialised client payload.
  const config = resolveConfig(process.env);

  return (
    <html lang="en">
      <body>
        <Providers config={config}>{children}</Providers>
      </body>
    </html>
  );
}
