import { Connection, PublicKey } from "@solana/web3.js";

// ✅ Correct Devnet USDC mint (you confirmed this)
const DEVNET_USDC_MINT = new PublicKey(
  "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
);

export async function getSolBalance(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  const lamports = await connection.getBalance(owner);
  return lamports / 1_000_000_000;
}

export async function getSplTokenBalance(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  const res = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: DEVNET_USDC_MINT,
  });

  return res.value.reduce((total, item) => {
    const amount = item.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    return total + amount;
  }, 0);
}
