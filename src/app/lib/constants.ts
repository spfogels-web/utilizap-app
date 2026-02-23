// src/app/lib/constants.ts
import { PublicKey } from "@solana/web3.js";

/**
 * ✅ MAINNET USDC mint
 * Official USDC mint on Solana mainnet-beta
 */
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

export const USDC_DECIMALS = 6;

export const CLUSTER: "mainnet-beta" = "mainnet-beta";