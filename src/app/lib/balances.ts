// src/app/lib/balances.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { USDC_MINT } from "@/app/lib/constants";

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
  const ata = await getAssociatedTokenAddress(USDC_MINT, owner);

  // If ATA doesn't exist, balance is 0
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info) return 0;

  const bal = await connection.getTokenAccountBalance(ata, "confirmed");
  const uiStr = bal?.value?.uiAmountString ?? "0";
  return Number(uiStr);
}