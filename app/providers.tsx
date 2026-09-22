"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createConfig, http, WagmiProvider, type CreateConnectorFn } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import { AppConfigContext } from "../lib/app-config-context";
import type { AppConfig } from "../lib/config";

/**
 * Wallet + data providers.
 *
 * Both Base networks are always registered so `switchChain` can move a wallet
 * from mainnet to Base Sepolia without recreating the wagmi config. The active
 * network's RPC comes from the server-resolved config; the other keeps its
 * public default.
 */
export function Providers({ config, children }: { config: AppConfig; children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  const wagmiConfig = useMemo(() => {
    const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true })];

    if (config.walletConnectProjectId) {
      connectors.push(
        walletConnect({ projectId: config.walletConnectProjectId, showQrModal: true }),
      );
    }

    const sepoliaRpc = config.networkKey === "sepolia" ? config.rpcUrl : "https://sepolia.base.org";
    const mainnetRpc = config.networkKey === "mainnet" ? config.rpcUrl : "https://mainnet.base.org";

    return createConfig({
      chains: [baseSepolia, base],
      connectors,
      transports: {
        [baseSepolia.id]: http(sepoliaRpc),
        [base.id]: http(mainnetRpc),
      },
      ssr: true,
    });
  }, [config.networkKey, config.rpcUrl, config.walletConnectProjectId]);

  return (
    <AppConfigContext.Provider value={config}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    </AppConfigContext.Provider>
  );
}
