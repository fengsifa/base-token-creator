"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig, http, WagmiProvider } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import { useState } from "react";
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const config = createConfig({ chains:[baseSepolia,base], connectors:[injected({shimDisconnect:true}), ...(projectId?[walletConnect({projectId,showQrModal:true})]:[])], transports:{[baseSepolia.id]:http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL||"https://sepolia.base.org"),[base.id]:http(process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL||"https://mainnet.base.org")}, ssr:true });
export function Providers({children}:{children:React.ReactNode}) { const [queryClient]=useState(()=>new QueryClient()); return <WagmiProvider config={config}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></WagmiProvider>; }
