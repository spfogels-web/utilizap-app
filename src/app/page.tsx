"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";

import { getSolBalance, getSplTokenBalance } from "./lib/balances";
import { sendUsdcDevnet, isValidSolanaAddress } from "./lib/transfer";

function shortAddr(address: string) {
  return address.slice(0, 4) + "..." + address.slice(-4);
}

type TxStage =
  | "idle"
  | "signing"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "failed";

export default function Home() {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);

  // Send UI state
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [isSending, setIsSending] = useState(false);

  // Transaction status state
  const [txStage, setTxStage] = useState<TxStage>("idle");
  const [txSig, setTxSig] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const explorerUrl = txSig
    ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
    : null;

  // ✅ Hydration fix
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // ✅ Guard so balances are NEVER fetched unless publicKey exists
  const refreshBalances = async () => {
    if (!publicKey) {
      setSolBalance(null);
      setUsdcBalance(null);
      return;
    }

    try {
      const sol = await getSolBalance(connection, publicKey);
      const usdc = await getSplTokenBalance(connection, publicKey);

      setSolBalance(sol);
      setUsdcBalance(usdc);
    } catch (e) {
      console.error(e);
      setSolBalance(null);
      setUsdcBalance(null);
    }
  };

  useEffect(() => {
    refreshBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, connection]);

  const canSend = useMemo(() => {
    if (!publicKey || !connected) return false;
    if (!signTransaction) return false;

    const trimmedRecipient = recipient.trim();
    if (!trimmedRecipient || !isValidSolanaAddress(trimmedRecipient)) return false;

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return false;

    return true;
  }, [publicKey, connected, signTransaction, recipient, amount]);

  const onSendUsdc = async () => {
    try {
      setTxError(null);
      setTxSig(null);
      setTxStage("idle");

      if (!publicKey) throw new Error("Connect your wallet first.");
      if (!signTransaction) throw new Error("Wallet cannot sign transactions.");

      const trimmedRecipient = recipient.trim();

      if (!trimmedRecipient) throw new Error("Enter a recipient address.");
      if (!isValidSolanaAddress(trimmedRecipient))
        throw new Error("Invalid recipient address.");

      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        throw new Error("Enter a valid amount.");
      }

      setIsSending(true);

      // 1) Wallet signing step
      setTxStage("signing");

      // 2) Submit tx (returns signature + blockhash context)
      const { signature, blockhash, lastValidBlockHeight } = await sendUsdcDevnet({
        connection,
        sender: publicKey,
        recipient: new PublicKey(trimmedRecipient),
        amountUi: amount, // string works better now (safer decimals)
        signTransaction,
      });

      setTxSig(signature);
      setTxStage("submitted");

      // 3) Confirm on-chain
      setTxStage("confirming");
      const conf = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      if (conf.value.err) {
        setTxStage("failed");
        setTxError("Transaction failed on-chain.");
        return;
      }

      setTxStage("confirmed");

      // Refresh balances after success
      await refreshBalances();
    } catch (e: any) {
      setTxStage("failed");
      setTxError(e?.message ?? "Send failed");
    } finally {
      setIsSending(false);
    }
  };

  const showTxPanel = txStage !== "idle";
  const isBusy = isSending || txStage === "signing" || txStage === "submitted" || txStage === "confirming";

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-2xl bg-white/5 border border-white/10 p-6">
        <h1 className="text-3xl font-bold text-center mb-2">UTILIZAP</h1>

        <p className="text-zinc-400 text-center mb-6">
          Non-custodial USDC wallet-to-wallet transfers on Solana
        </p>

        {mounted ? (
          <WalletMultiButton className="w-full justify-center" />
        ) : (
          <button
            className="w-full justify-center rounded-md px-4 py-2 bg-white/10 text-white/70 cursor-not-allowed"
            disabled
          >
            Loading wallet…
          </button>
        )}

        {connected && publicKey && (
          <div className="mt-6 bg-black/40 border border-white/10 rounded-xl p-4 space-y-2 text-center">
            <p className="text-sm text-zinc-400">Connected Wallet</p>

            <p className="font-mono text-lg">{shortAddr(publicKey.toBase58())}</p>

            <div className="pt-2 text-sm text-zinc-300 space-y-1">
              <div>SOL: {solBalance ?? "—"}</div>
              <div>USDC (devnet): {usdcBalance ?? "—"}</div>
            </div>

            <p className="text-xs text-zinc-500 pt-2">Devnet (safe testing)</p>
          </div>
        )}

        <div className="mt-6 w-full rounded-2xl border border-white/10 bg-white/5 p-4">
          <h3 className="text-base font-semibold">Send USDC (Devnet)</h3>

          <div className="mt-3 text-left">
            <label className="text-sm text-zinc-300">Recipient Wallet</label>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Recipient Solana address"
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-sm outline-none"
            />
            {recipient.trim().length > 0 && !isValidSolanaAddress(recipient.trim()) && (
              <div className="mt-2 text-xs text-red-300">Invalid address format.</div>
            )}
          </div>

          <div className="mt-3 text-left">
            <label className="text-sm text-zinc-300">Amount (USDC)</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 1.5"
              inputMode="decimal"
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-sm outline-none"
            />
          </div>

          <button
            onClick={onSendUsdc}
            disabled={!canSend || isBusy}
            className="mt-4 w-full rounded-xl bg-white/90 p-3 text-sm font-semibold text-black disabled:opacity-50"
          >
            {isBusy ? "Processing..." : "Send USDC"}
          </button>

          {!connected && (
            <div className="mt-3 text-xs text-zinc-400">
              Connect your wallet to send USDC.
            </div>
          )}

          {/* Transaction Status Panel */}
          {showTxPanel && (
            <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm">
                  <div className="font-semibold">Transaction Status</div>
                  <div className="opacity-80">
                    {txStage === "signing" && "Waiting for wallet signature…"}
                    {txStage === "submitted" && "Submitted. Network is processing…"}
                    {txStage === "confirming" && "Confirming on-chain…"}
                    {txStage === "confirmed" && "✅ Confirmed"}
                    {txStage === "failed" && "❌ Failed"}
                  </div>
                </div>

                {txSig && (
                  <button
                    onClick={() => navigator.clipboard.writeText(txSig)}
                    className="text-xs rounded-lg border border-white/10 px-3 py-2 hover:bg-white/5"
                  >
                    Copy Tx
                  </button>
                )}
              </div>

              {txSig && (
                <div className="mt-3 break-all text-xs opacity-90">
                  <div className="opacity-70">Signature</div>
                  <div className="mt-1">{txSig}</div>

                  {explorerUrl && (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-blue-400 hover:underline"
                    >
                      View on Solana Explorer →
                    </a>
                  )}
                </div>
              )}

              {txError && <div className="mt-3 text-xs text-red-300">{txError}</div>}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
