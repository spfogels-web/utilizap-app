"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";

import { getSolBalance, getSplTokenBalance } from "./lib/balances";
import { sendUsdcDevnet, isValidSolanaAddress } from "./lib/transfer";
import QrScanButton from "./components/QrScanButton";

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
  const { publicKey, connected, signTransaction, disconnect } = useWallet();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <main className="min-h-screen text-white bg-black relative">
      {/* Premium background layers */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_20%_10%,rgba(120,80,255,.20),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_80%_20%,rgba(255,210,120,.14),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_50%_90%,rgba(70,140,255,.16),transparent_60%)]" />
        <div className="absolute inset-0 opacity-30 bg-[linear-gradient(to_right,rgba(255,255,255,.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,.06)_1px,transparent_1px)] bg-[size:64px_64px]" />
      </div>

      {/* App shell */}
      <div className="relative mx-auto w-full max-w-5xl px-4 sm:px-6 py-8">
        {/* Header */}
        <header className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md px-4 sm:px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/brand/utilizap-logo.png"
              alt="UTILIZAP"
              draggable={false}
              className="h-10 w-auto select-none"
            />
            <div className="min-w-0">
              <div className="text-xs text-zinc-400 truncate">
                Non-custodial USDC wallet-to-wallet transfers on Solana
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1 text-xs text-zinc-300">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400/80" />
              Devnet
            </span>

            {mounted ? (
              <WalletMultiButton className="uz-wallet-btn" />
            ) : (
              <button
                className="rounded-lg px-4 py-2 bg-white/10 text-white/70 cursor-not-allowed"
                disabled
              >
                Loading…
              </button>
            )}
          </div>
        </header>

        {/* Content grid */}
        <section className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Wallet */}
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-bold">Wallet</h2>
              <span className="text-xs text-zinc-400">
                Secure • Non-custodial
              </span>
            </div>

            {connected && publicKey ? (
              <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-4 text-center space-y-2">
                <p className="text-sm text-zinc-400">Connected Wallet</p>
                <p className="font-mono text-lg">
                  {shortAddr(publicKey.toBase58())}
                </p>

                <div className="text-sm text-zinc-300">
                  <div>SOL: {solBalance ?? "—"}</div>
                  <div>USDC (devnet): {usdcBalance ?? "—"}</div>
                </div>

                <p className="text-xs text-zinc-500">Devnet (safe testing)</p>

                <button
                  onClick={() => disconnect()}
                  className="uz-danger-btn w-full mt-3 py-2"
                >
                  Disconnect Wallet
                </button>
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-4 text-sm text-zinc-300">
                Connect a wallet to view balances and send USDC.
              </div>
            )}
          </div>

          {/* Right: Send */}
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-bold">Send USDC</h2>
              <span className="text-xs text-zinc-400">Devnet</span>
            </div>

            <div className="mt-4">
              <label className="text-xs text-zinc-400">Recipient</label>

              <div className="mt-2 mb-4 flex items-center gap-3">
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Recipient Solana address"
                  className="w-full rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
                />

                <QrScanButton
                  validate={(v) => isValidSolanaAddress(v.trim())}
                  onScan={(value) => setRecipient(value.trim())}
                  disabled={!connected}
                />
              </div>

              <label className="text-xs text-zinc-400">Amount</label>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Amount (USDC)"
                className="w-full mt-2 mb-4 rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
              />

              <button
                onClick={onSendUsdc}
                disabled={!canSend || isBusy}
                className="uz-primary-btn w-full rounded-xl py-3 font-semibold text-white disabled:cursor-not-allowed"
              >
                {isBusy ? "Processing…" : "Send USDC"}
              </button>
            </div>
          </div>
        </section>

        <footer className="mt-8 text-center text-xs text-zinc-500">
          UTILIZAP • Non-custodial payments • Devnet environment
        </footer>
      </div>
    </main>
  );
}
