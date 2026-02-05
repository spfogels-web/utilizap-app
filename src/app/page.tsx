"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import QRCode from "qrcode";

import { getSolBalance, getSplTokenBalance } from "./lib/balances";
import { sendUsdcDevnet, isValidSolanaAddress } from "./lib/transfer";

import QrScanButton from "./components/QrScanButton";
import ReceiveQr from "./components/ReceiveQr";

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

// Premium currency formatting (USDC as "cash")
const formatUsd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);

// --------------------
// CONTACTS (local-only)
// --------------------
type Contact = {
  id: string;
  name: string;
  address: string;
};

const CONTACTS_KEY = "uz_contacts_v1";

function safeParseContacts(raw: string | null): Contact[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c) =>
          c &&
          typeof c.id === "string" &&
          typeof c.name === "string" &&
          typeof c.address === "string"
      )
      .map((c) => ({
        id: c.id,
        name: c.name.trim(),
        address: c.address.trim(),
      }));
  } catch {
    return [];
  }
}

function loadContacts(): Contact[] {
  if (typeof window === "undefined") return [];
  return safeParseContacts(window.localStorage.getItem(CONTACTS_KEY));
}

function saveContacts(next: Contact[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CONTACTS_KEY, JSON.stringify(next));
}

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    // @ts-ignore
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// ✅ Inner component that uses useSearchParams()
// Wrapped by Suspense in the default export below.
function HomeInner() {
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

  // CONTACTS state
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactName, setContactName] = useState("");

  const explorerUrl = txSig
    ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
    : null;

  // Hydration-safe UI gate
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // --------------------
  // Step 2: REQUEST PAYMENT LINK (generator + copy + QR)
  // --------------------
  const [origin, setOrigin] = useState<string>("");
  const [requestAmount, setRequestAmount] = useState<string>("");
  const [copied, setCopied] = useState(false);

  // QR (for request link)
  const [showRequestQr, setShowRequestQr] = useState(false);
  const [requestQr, setRequestQr] = useState<string>("");

  useEffect(() => {
    if (!mounted) return;
    setOrigin(window.location.origin);
  }, [mounted]);

  const requestLink = useMemo(() => {
    if (!origin || !publicKey) return "";
    const to = publicKey.toBase58();

    const params = new URLSearchParams();
    params.set("to", to);

    const a = requestAmount.trim();
    if (a) {
      const n = Number(a);
      if (Number.isFinite(n) && n > 0) {
        params.set("amount", a);
      }
    }

    return `${origin}/?${params.toString()}`;
  }, [origin, publicKey, requestAmount]);

  async function copyRequestLink() {
    if (!requestLink) return;
    try {
      await navigator.clipboard.writeText(requestLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // fallback (rare)
      try {
        const el = document.getElementById(
          "uz-request-link"
        ) as HTMLInputElement;
        if (el) {
          el.focus();
          el.select();
          document.execCommand("copy");
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        }
      } catch {
        // ignore
      }
    }
  }

  // Generate QR image whenever requestLink changes
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!requestLink) {
        setRequestQr("");
        return;
      }
      try {
        const dataUrl = await QRCode.toDataURL(requestLink, {
          width: 220,
          margin: 1,
        });
        if (!cancelled) setRequestQr(dataUrl);
      } catch {
        if (!cancelled) setRequestQr("");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [requestLink]);

  // If link becomes empty, hide QR
  useEffect(() => {
    if (!requestLink) setShowRequestQr(false);
  }, [requestLink]);

  // --------------------
  // SHAREABLE PAY LINK PREFILL (Step 1)
  // Format: /?to=ADDRESS&amount=1.25
  // --------------------
  const searchParams = useSearchParams();
  const [prefillDone, setPrefillDone] = useState(false);

  useEffect(() => {
    if (!mounted) return;
    if (prefillDone) return;

    const to = searchParams.get("to");
    const amt = searchParams.get("amount");

    let didAnything = false;

    if (to && isValidSolanaAddress(to.trim())) {
      setRecipient(to.trim());
      didAnything = true;
    }

    if (amt) {
      const clean = amt.trim();
      const n = Number(clean);
      if (Number.isFinite(n) && n > 0) {
        setAmount(clean);
        didAnything = true;
      }
    }

    if (didAnything) setPrefillDone(true);
  }, [mounted, prefillDone, searchParams]);

  // Load contacts after mount
  useEffect(() => {
    const initial = loadContacts();
    setContacts(initial);
  }, []);

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

  // Selected contact display (safe / UI-only)
  const selectedContact = useMemo(() => {
    const r = recipient.trim().toLowerCase();
    if (!r) return null;
    return contacts.find((c) => c.address.trim().toLowerCase() === r) ?? null;
  }, [contacts, recipient]);

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

  const isConfirmed = txStage === "confirmed";

  // USDC "cash" display (big)
  const usdcCash = usdcBalance === null ? "—" : formatUsd(usdcBalance);

  // SOL precise display (small)
  const solPrecise = solBalance === null ? "—" : solBalance.toFixed(4);

  // --------------------
  // CONTACTS helpers
  // --------------------
  function chooseContact(address: string) {
    setRecipient(address);
  }

  function deleteContact(id: string) {
    setContacts((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveContacts(next);
      return next;
    });
  }

  function addContactFromRecipient() {
    const name = contactName.trim();
    const address = recipient.trim();

    if (!name) return;
    if (!address) return;
    if (!isValidSolanaAddress(address)) return;

    const newContact: Contact = { id: makeId(), name, address };

    setContacts((prev) => {
      const addrLower = address.toLowerCase();
      const nameLower = name.toLowerCase();

      const exists = prev.some(
        (c) =>
          c.address.toLowerCase() === addrLower ||
          (c.address.toLowerCase() === addrLower &&
            c.name.toLowerCase() === nameLower)
      );

      const next = exists ? prev : [newContact, ...prev];
      saveContacts(next);
      return next;
    });

    setContactName("");
  }

  return (
    <main className="min-h-screen text-white bg-black relative">
      {/* Premium background layers (non-clickable) */}
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

        {/* Content gate */}
        {connected && publicKey ? (
          /* APP MODE */
          <section className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: Wallet */}
            <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-lg font-bold">Wallet</h2>
                <span className="text-xs text-zinc-400">
                  Secure • Non-custodial
                </span>
              </div>

              <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-4 space-y-4">
                {/* Connected Wallet */}
                <div className="text-center space-y-1">
                  <p className="text-sm text-zinc-400">Connected Wallet</p>
                  <p className="font-mono text-lg">
                    {shortAddr(publicKey.toBase58())}
                  </p>
                </div>

                {/* Balance section (USDC first / SOL secondary) */}
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
                  {/* Available (USDC) */}
                  <div className="px-4 py-4 border-b border-white/10">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[11px] uppercase tracking-wider text-zinc-400">
                          Available Balance
                        </p>
                        <p className="mt-1 text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                          {usdcCash}{" "}
                          <span className="text-white/60 text-base sm:text-lg font-semibold">
                            USDC
                          </span>
                        </p>
                        <p className="mt-1 text-sm text-zinc-500">
                          Ready to send
                        </p>
                      </div>

                      <div
                        className="h-10 w-10 rounded-xl border border-white/10"
                        style={{
                          background:
                            "linear-gradient(135deg, rgba(124,58,237,.35), rgba(99,102,241,.25))",
                        }}
                        aria-hidden="true"
                      />
                    </div>

                    <div className="mt-2 text-[11px] text-zinc-500">
                      USDC (devnet)
                    </div>
                  </div>

                  {/* Network (SOL) */}
                  <div className="px-4 py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[11px] uppercase tracking-wider text-zinc-400">
                          Network Balance
                        </p>
                        <p className="mt-1 text-lg font-bold text-white">
                          {solPrecise}{" "}
                          <span className="text-white/60 font-semibold">
                            SOL
                          </span>
                        </p>
                        <p className="mt-1 text-sm text-zinc-500">
                          Used for network fees
                        </p>
                      </div>

                      <span className="text-xs px-3 py-1 rounded-full border border-white/10 bg-black/40 text-zinc-300">
                        Devnet
                      </span>
                    </div>
                  </div>
                </div>

                {/* RECEIVE QR */}
                <ReceiveQr className="mt-1" />

                <button
                  onClick={() => disconnect()}
                  className="uz-danger-btn w-full mt-1 py-2"
                >
                  Disconnect Wallet
                </button>
              </div>
            </div>

            {/* Right: Send */}
            <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-lg font-bold">Send USDC</h2>
                <span className="text-xs text-zinc-400">Devnet</span>
              </div>

              <div className="mt-4">
                {/* Request payment link */}
                <div className="mb-5 rounded-2xl border border-white/10 bg-black/30 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-white">
                        Request Payment Link
                      </div>
                      <div className="mt-1 text-xs text-zinc-400">
                        Share a link that opens UTILIZAP pre-filled to pay you
                      </div>
                    </div>
                    <span className="text-[11px] px-2 py-1 rounded-full border border-white/10 bg-white/5 text-zinc-300">
                      Shareable
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-1">
                      <label className="text-xs text-zinc-400">
                        Amount (optional)
                      </label>
                      <input
                        value={requestAmount}
                        onChange={(e) => setRequestAmount(e.target.value)}
                        placeholder="e.g., 25"
                        className="w-full mt-2 rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
                        inputMode="decimal"
                        disabled={!mounted}
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <label className="text-xs text-zinc-400">Link</label>
                      <div className="mt-2 flex items-center gap-3">
                        <input
                          id="uz-request-link"
                          value={requestLink || ""}
                          readOnly
                          className="w-full rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none text-zinc-200"
                          placeholder="Connect wallet to generate link…"
                        />
                        <button
                          type="button"
                          onClick={copyRequestLink}
                          disabled={!requestLink}
                          className="uz-btn-secondary"
                          title="Copy link"
                        >
                          {copied ? "Copied ✓" : "Copy"}
                        </button>
                      </div>

                      <div className="mt-2 text-[11px] text-zinc-500">
                        Opens:{" "}
                        <span className="text-zinc-300">
                          Recipient + Amount
                        </span>{" "}
                        auto-filled
                      </div>

                      {/* Payment-link QR toggle */}
                      <div className="mt-3 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setShowRequestQr((v) => !v)}
                          disabled={!requestLink}
                          className="uz-btn-secondary"
                        >
                          {showRequestQr ? "Hide QR" : "Show QR"}
                        </button>
                        <span className="text-[11px] text-zinc-400">
                          Scan to open payment request
                        </span>
                      </div>

                      {showRequestQr && requestQr && (
                        <div className="mt-4 flex justify-center">
                          <div className="rounded-xl bg-black p-3 border border-white/10">
                            <img
                              src={requestQr}
                              alt="Payment request QR"
                              className="h-[220px] w-[220px]"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <label className="text-xs text-zinc-400">Recipient</label>

                {/* ✅ Scanner panel lives HERE (above the row) so it never pushes left */}
                {mounted ? (
                  <QrScanButton
                    mode="panel"
                    validate={(v) => isValidSolanaAddress(v.trim())}
                    onScan={(value) => setRecipient(value.trim())}
                    disabled={!connected || isBusy}
                  />
                ) : null}

                {/* Recipient row */}
                <div className="mt-2 mb-4 flex items-center gap-3">
                  <input
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder="Recipient Solana address"
                    className="w-full rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
                    inputMode="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={isBusy}
                  />

                  {/* Clear recipient */}
                  <button
  type="button"
  onClick={() => setRecipient("")}
  disabled={isBusy || !recipient.trim()}
  className="uz-btn-clear"
  title="Clear recipient"
>
  Clear
</button>


                  {mounted ? (
                    <QrScanButton
                      mode="button"
                      validate={(v) => isValidSolanaAddress(v.trim())}
                      onScan={(value) => setRecipient(value.trim())}
                      disabled={!connected || isBusy}
                    />
                  ) : (
                    <button type="button" className="uz-btn-secondary" disabled>
                      Scan
                    </button>
                  )}
                </div>

                {/* Selected contact label */}
                {selectedContact ? (
                  <div className="mt-1 mb-3 text-xs text-zinc-400">
                    Selected contact:{" "}
                    <span className="text-white/80 font-semibold">
                      {selectedContact.name}
                    </span>
                  </div>
                ) : (
                  <div className="mb-3" />
                )}

                {/* CONTACTS */}
                <div className="mb-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-zinc-400">Contacts</p>
                    <p className="text-[11px] text-zinc-500">
                      Saved on this device
                    </p>
                  </div>

                  <div className="mt-2 flex flex-col sm:flex-row gap-3">
                    <input
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                      placeholder="Name (e.g., Mike)"
                      className="w-full sm:flex-1 rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
                      disabled={isBusy}
                    />

                    <button
                      type="button"
                      onClick={addContactFromRecipient}
                      disabled={
                        isBusy ||
                        !contactName.trim() ||
                        !isValidSolanaAddress(recipient.trim())
                      }
                      className="uz-btn-secondary"
                    >
                      Save Contact
                    </button>
                  </div>

                  {contacts.length > 0 ? (
                    <div className="mt-3 rounded-xl border border-white/10 bg-black/30 overflow-hidden">
                      {contacts.map((c) => {
                        const isSelected =
                          recipient.trim().toLowerCase() ===
                          c.address.toLowerCase();

                        return (
                          <div
                            key={c.id}
                            className={[
                              "flex items-center justify-between gap-3 px-3 py-3 border-b border-white/10 last:border-b-0",
                              isSelected
                                ? "bg-white/10"
                                : "hover:bg-white/[0.06]",
                            ].join(" ")}
                          >
                            <button
                              type="button"
                              onClick={() => chooseContact(c.address)}
                              disabled={isBusy}
                              className="text-left flex-1 min-w-0"
                              title="Use this contact"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-sm font-semibold text-white truncate">
                                  {c.name}
                                </span>
                                {isSelected ? (
                                  <span className="text-[11px] px-2 py-0.5 rounded-full border border-white/10 bg-white/10 text-zinc-200">
                                    Selected
                                  </span>
                                ) : null}
                              </div>
                              <div className="mt-1 text-[11px] text-zinc-400 font-mono truncate">
                                {c.address}
                              </div>
                            </button>

                            <button
                              type="button"
                              onClick={() => deleteContact(c.id)}
                              disabled={isBusy}
                              className="uz-btn-danger-soft"
                              title="Delete contact"
                            >
                              Delete
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-3 rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-xs text-zinc-400">
                      No contacts yet. Enter a name and use a valid recipient
                      address, then hit{" "}
                      <span className="text-white/80 font-semibold">
                        Save Contact
                      </span>
                      .
                    </div>
                  )}
                </div>

                <label className="text-xs text-zinc-400">Amount</label>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Amount (USDC)"
                  className="w-full mt-2 mb-4 rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
                  inputMode="decimal"
                  disabled={isBusy}
                />

                <button
                  onClick={onSendUsdc}
                  disabled={!canSend || isBusy}
                  className={[
                    "uz-primary-btn w-full rounded-xl py-3 font-semibold text-white disabled:cursor-not-allowed",
                    isConfirmed ? "uz-complete-pop" : "",
                  ].join(" ")}
                >
                  {txStage === "signing" || txStage === "confirming"
                    ? "Confirming…"
                    : txStage === "confirmed"
                    ? "Complete ✓"
                    : isBusy
                    ? "Processing…"
                    : "Send USDC"}
                </button>

                {txStage === "signing" && (
                  <div className="mt-2 text-xs text-zinc-400">
                    Approve in Phantom…
                  </div>
                )}

                {txStage === "confirming" && (
                  <div className="mt-2 text-xs text-zinc-400">
                    Confirming on Solana…
                  </div>
                )}

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
          </section>
        ) : (
          /* LANDING MODE */
          <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-8 sm:p-10 text-center">
            <div className="text-xs text-zinc-400">UTILIZAP • Devnet Preview</div>

            <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight">
              Venmo-style USDC payments,
              <span className="block text-zinc-200">
                Non-custodial. Instant.
              </span>
            </h1>

            <p className="mt-4 max-w-2xl mx-auto text-sm sm:text-base text-zinc-300">
              Connect your wallet to access the UTILIZAP dashboard and send USDC
              with QR and on-chain confirmation.
            </p>

            <div className="mt-6 flex justify-center">
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

            <div className="mt-4 text-xs text-zinc-500">
              Utility first. Build first. Launch second.
            </div>
          </section>
        )}

        <footer className="mt-8 text-center text-xs text-zinc-500">
          UTILIZAP • Non-custodial payments • Devnet environment
        </footer>
      </div>

      {/* Complete ✓ pop animation (CSS only) */}
      <style jsx>{`
        @keyframes uzCompletePop {
          0% {
            transform: scale(1);
          }
          45% {
            transform: scale(1.06);
          }
          70% {
            transform: scale(0.98);
          }
          100% {
            transform: scale(1);
          }
        }

        .uz-complete-pop {
          animation: uzCompletePop 420ms ease-out;
        }
      `}</style>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-black text-white flex items-center justify-center">
          <div className="text-sm text-white/70">Loading…</div>
        </main>
      }
    >
      <HomeInner />
    </Suspense>
  );
}
