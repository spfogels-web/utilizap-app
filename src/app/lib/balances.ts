// src/app/lib/balances.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { DEVNET_USDC_MINT } from "@/app/lib/constants";

export async function getSolBalance(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  const lamports = await connection.getBalance(owner, "confirmed");
  return lamports / 1_000_000_000;
}

export async function getSplTokenBalance(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  // ✅ This MUST match your transfer mint
  const ata = await getAssociatedTokenAddress(DEVNET_USDC_MINT, owner);

  // If ATA doesn't exist, balance is 0
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info) return 0;

  // Fetch token amount
  const bal = await connection.getTokenAccountBalance(ata, "confirmed");
  const uiStr = bal?.value?.uiAmountString ?? "0";
  return Number(uiStr);
}
