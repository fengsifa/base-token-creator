"use client";

import { createContext, useContext } from "react";
import type { AppConfig } from "./config";

/**
 * The resolved app configuration, provided once at the root by `<Providers>`.
 * The value comes from the server (see app/layout.tsx), which is what makes the
 * Factory address a runtime setting instead of a build-time one.
 */
export const AppConfigContext = createContext<AppConfig | null>(null);

export function useAppConfig(): AppConfig {
  const config = useContext(AppConfigContext);
  if (!config) {
    throw new Error("useAppConfig() must be called inside <Providers> (see app/layout.tsx).");
  }
  return config;
}
