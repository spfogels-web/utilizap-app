// src/app/lib/transfer.ts
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

const DEVNET_USDC_MINT_STR = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const USDC_DECIMALS = 6;

export function isValidSolanaAddress(value: string) {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * UI -> base units (6 decimals) without float rounding issues.
 * Accepts number or string (recommended: string from input).
 */
function uiToBaseUnits(amountUi: number | string, decimals: number): bigint {
  const s = String(amountUi).trim();
  if (!s) throw new Error("Amount is required.");

  // Basic numeric validation
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount format.");

  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);

  // Avoid bigint literal issues by using BigInt() conversions
  const scale = BigInt(10 ** decimals);
  const base = BigInt(whole || "0") * scale + BigInt(fracPadded || "0");

  if (base <= 0n) throw new Error("Amount must be greater than 0.");
  return base;
}

export async function sendUsdcDevnet(params: {
  connection: Connection;
  sender: PublicKey;
  recipient: PublicKey;
  amountUi: number | string; // <-- allow string for safer parsing
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}): Promise<{
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}> {
  const { connection, sender, recipient, amountUi, signTransaction } = params;

  const mint = new PublicKey(DEVNET_USDC_MINT_STR);

  // Convert UI amount to base units (6 decimals)
  const amountBase = uiToBaseUnits(amountUi, USDC_DECIMALS);

  const senderAta = await getAssociatedTokenAddress(mint, sender);
  const recipientAta = await getAssociatedTokenAddress(mint, recipient);

  const ix: any[] = [];

  // Create recipient ATA if missing
  const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
  if (!recipientAtaInfo) {
    ix.push(
      createAssociatedTokenAccountInstruction(
        sender,       // payer
        recipientAta, // associated token account
        recipient,    // owner
        mint          // mint
      )
    );
  }

  // Transfer USDC
  ix.push(
    createTransferCheckedInstruction(
      senderAta,
      mint,
      recipientAta,
      sender,
      amountBase,
      USDC_DECIMALS
    )
  );

  const tx = new Transaction().add(...ix);
  tx.feePayer = sender;

  // Use latest blockhash context so UI can reliably confirm + show status
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  tx.recentBlockhash = blockhash;

  const signed = await signTransaction(tx);

  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  // NOTE: we are intentionally NOT confirming here anymore.
  // We return the info so page.tsx can show:
  // submitted -> confirming -> confirmed/failed
  return { signature, blockhash, lastValidBlockHeight };
}
