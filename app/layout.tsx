import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
export const metadata: Metadata = { title: "Base Token Creator", description: "Create a standard ERC-20 token on Base." };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="en"><body><Providers>{children}</Providers></body></html>; }
