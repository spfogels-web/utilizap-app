// src/app/lib/transfer.ts
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

import { DEVNET_USDC_MINT, USDC_DECIMALS } from "./constants";

export function isValidSolanaAddress(value: string) {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function uiToBaseUnits(amountUi: number | string, decimals: number): bigint {
  const s = String(amountUi).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount");

  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);

  return (
    BigInt(whole || "0") * BigInt(10 ** decimals) +
    BigInt(fracPadded || "0")
  );
}

export async function sendUsdcDevnet(params: {
  connection: Connection;
  sender: PublicKey;
  recipient: PublicKey;
  amountUi: number | string;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}) {
  const { connection, sender, recipient, amountUi, signTransaction } = params;

  const amountBase = uiToBaseUnits(amountUi, USDC_DECIMALS);

  // 🔒 Explicit ATA resolution
  const senderAta = await getAssociatedTokenAddress(
    DEVNET_USDC_MINT,
    sender,
    false
  );

  const recipientAta = await getAssociatedTokenAddress(
    DEVNET_USDC_MINT,
    recipient,
    false
  );

  // 🚨 Sender MUST have an ATA
  const senderAtaInfo = await connection.getAccountInfo(senderAta);
  if (!senderAtaInfo) {
    throw new Error("Sender does not have a USDC token account");
  }

  const ix = [];

  // Create recipient ATA if missing
  const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
  if (!recipientAtaInfo) {
    ix.push(
      createAssociatedTokenAccountInstruction(
        sender,
        recipientAta,
        recipient,
        DEVNET_USDC_MINT
      )
    );
  }

  // ✅ Correct transfer: sender ATA → recipient ATA
  ix.push(
    createTransferCheckedInstruction(
      senderAta,
      DEVNET_USDC_MINT,
      recipientAta,
      sender,
      amountBase,
      USDC_DECIMALS
    )
  );

  const tx = new Transaction().add(...ix);
  tx.feePayer = sender;

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  tx.recentBlockhash = blockhash;

  const signed = await signTransaction(tx);

  const signature = await connection.sendRawTransaction(
    signed.serialize(),
    { skipPreflight: false }
  );

  return { signature, blockhash, lastValidBlockHeight };
}
