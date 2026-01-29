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

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [isSending, setIsSending] = useState(false);

  const [txStage, setTxStage] = useState<TxStage>("idle");
  const [txSig, setTxSig] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const explorerUrl = txSig
    ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
    : null;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
    } catch {
      setSolBalance(null);
      setUsdcBalance(null);
    }
  };

  useEffect(() => {
    refreshBalances();
  }, [publicKey, connection]);

  const canSend = useMemo(() => {
    if (!publicKey || !connected || !signTransaction) return false;
    if (!isValidSolanaAddress(recipient.trim())) return false;
    const amt = Number(amount);
    return Number.isFinite(amt) && amt > 0;
  }, [publicKey, connected, signTransaction, recipient, amount]);

  const onSendUsdc = async () => {
    try {
      setTxError(null);
      setTxSig(null);
      setTxStage("signing");
      setIsSending(true);

      const { signature, blockhash, lastValidBlockHeight } =
        await sendUsdcDevnet({
          connection,
          sender: publicKey!,
          recipient: new PublicKey(recipient.trim()),
          amountUi: amount,
          signTransaction: signTransaction!,
        });

      setTxSig(signature);
      setTxStage("confirming");

      const conf = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      if (conf.value.err) throw new Error("Transaction failed");

      setTxStage("confirmed");
      refreshBalances();
    } catch (e: any) {
      setTxStage("failed");
      setTxError(e?.message ?? "Send failed");
    } finally {
      setIsSending(false);
    }
  };

  const showTxPanel = txStage !== "idle";
  const isBusy =
    isSending ||
    txStage === "signing" ||
    txStage === "submitted" ||
    txStage === "confirming";

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="uz-execution-card max-w-md w-full rounded-2xl p-6">

        {/* Logo */}
        <div className="flex justify-center mb-4">
          <img
            src="/brand/utilizap-logo.png"
            alt="UTILIZAP"
            draggable={false}
            className="h-16 w-auto select-none"
          />
        </div>

        {/* Subtitle */}
        <p className="text-zinc-400 text-center mb-6">
          Non-custodial USDC wallet-to-wallet transfers on Solana
        </p>

        {/* Wallet Button */}
        {mounted ? (
          <div className="flex justify-center">
            <WalletMultiButton className="uz-wallet-btn" />
          </div>
        ) : (
          <button
            className="w-full rounded-md px-4 py-2 bg-white/10 text-white/70 cursor-not-allowed"
            disabled
          >
            Loading wallet…
          </button>
        )}

        {/* Connected Wallet */}
        {connected && publicKey && (
          <div className="mt-6 bg-black/40 border border-white/10 rounded-xl p-4 text-center space-y-2">
            <p className="text-sm text-zinc-400">Connected Wallet</p>
            <p className="font-mono text-lg">
              {shortAddr(publicKey.toBase58())}
            </p>
            <div className="text-sm text-zinc-300">
              <div>SOL: {solBalance ?? "—"}</div>
              <div>USDC (devnet): {usdcBalance ?? "—"}</div>
            </div>
            <p className="text-xs text-zinc-500">Devnet (safe testing)</p>
          </div>
        )}

        {/* Send Panel */}
        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4">
          <h3 className="font-semibold mb-3">Send USDC (Devnet)</h3>

          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Recipient Solana address"
            className="w-full mb-3 rounded-lg bg-black/40 border border-white/10 p-3 text-sm"
          />

          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount (USDC)"
            className="w-full mb-3 rounded-lg bg-black/40 border border-white/10 p-3 text-sm"
          />

          <button
            onClick={onSendUsdc}
            disabled={!canSend || isBusy}
            className="w-full rounded-lg bg-white/90 text-black font-semibold py-3 disabled:opacity-50"
          >
            {isBusy ? "Processing…" : "Send USDC"}
          </button>

          {showTxPanel && (
            <div className="mt-4 text-xs">
              {txError && <div className="text-red-400">{txError}</div>}
              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-400 underline"
                >
                  View transaction →
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
