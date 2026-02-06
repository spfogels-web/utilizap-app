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

// --------------------
// RECEIPTS (local-only)
// --------------------
type TxReceiptStatus = "submitted" | "confirming" | "confirmed" | "failed";

type TxReceipt = {
  id: string;
  sig: string | null;
  createdAt: number;

  cluster: "devnet" | "mainnet-beta";
  status: TxReceiptStatus;

  amountUi: string;
  tokenSymbol: "USDC";

  from: string;
  to: string;

  explorerUrl: string | null;
  note?: string;
};

const RECEIPTS_KEY = "uz_receipts_v1";

function ensureReceiptsStore() {
  if (typeof window === "undefined") return;
  try {
    const existing = window.localStorage.getItem(RECEIPTS_KEY);
    if (existing === null) window.localStorage.setItem(RECEIPTS_KEY, "[]");
  } catch {
    // ignore
  }
}

function safeParseReceipts(raw: string | null): TxReceipt[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r) =>
          r &&
          typeof r.id === "string" &&
          typeof r.createdAt === "number" &&
          (r.sig === null || typeof r.sig === "string") &&
          (r.cluster === "devnet" || r.cluster === "mainnet-beta") &&
          (r.status === "submitted" ||
            r.status === "confirming" ||
            r.status === "confirmed" ||
            r.status === "failed") &&
          typeof r.amountUi === "string" &&
          r.tokenSymbol === "USDC" &&
          typeof r.from === "string" &&
          typeof r.to === "string"
      )
      .map((r) => ({
        id: r.id,
        sig: r.sig ?? null,
        createdAt: r.createdAt,
        cluster: r.cluster,
        status: r.status,
        amountUi: String(r.amountUi ?? "").trim(),
        tokenSymbol: "USDC" as const,
        from: String(r.from ?? "").trim(),
        to: String(r.to ?? "").trim(),
        explorerUrl: typeof r.explorerUrl === "string" ? r.explorerUrl : null,
        note: typeof r.note === "string" ? r.note : undefined,
      }));
  } catch {
    return [];
  }
}

function loadReceipts(): TxReceipt[] {
  if (typeof window === "undefined") return [];
  try {
    ensureReceiptsStore();
    return safeParseReceipts(window.localStorage.getItem(RECEIPTS_KEY));
  } catch {
    return [];
  }
}

function saveReceipts(next: TxReceipt[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECEIPTS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function upsertReceipt(next: TxReceipt) {
  try {
    ensureReceiptsStore();
    const prev = loadReceipts();
    const idx = prev.findIndex((r) => r.id === next.id);
    const merged =
      idx >= 0
        ? [next, ...prev.filter((r) => r.id !== next.id)]
        : [next, ...prev];
    saveReceipts(merged);
  } catch {
    // ignore
  }
}

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

function HomeInner() {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction, disconnect } = useWallet();

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [txNote, setTxNote] = useState("");
  const [isSending, setIsSending] = useState(false);

  const [txStage, setTxStage] = useState<TxStage>("idle");
  const [txSig, setTxSig] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  // Receipts
  const [receipts, setReceipts] = useState<TxReceipt[]>([]);
  const [activeReceipt, setActiveReceipt] = useState<TxReceipt | null>(null);

  // Receipt UI
  const [showReceipt, setShowReceipt] = useState(false);
  const [receiptCopied, setReceiptCopied] = useState(false);
  const [sigCopied, setSigCopied] = useState(false);

  // ✅ FIXED: no ": any" here
  const [receiptNoteDraft, setReceiptNoteDraft] = useState<string>("");
  const [noteSavedTick, setNoteSavedTick] = useState(false);

  // Receipt history controls
  const [receiptSearch, setReceiptSearch] = useState("");
  const [receiptFilter, setReceiptFilter] = useState<
    "all" | "confirmed" | "pending" | "failed"
  >("all");

  // Contacts
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactName, setContactName] = useState("");

  const explorerUrl = txSig
    ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
    : null;

  // Hydration-safe UI gate
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  function fmtWhen(ts: number) {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return "";
    }
  }

  function shortMid(s: string, head = 6, tail = 6) {
    if (!s) return "—";
    if (s.length <= head + tail + 3) return s;
    return `${s.slice(0, head)}…${s.slice(-tail)}`;
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function refreshReceiptsFromStorage() {
    const latest = loadReceipts();
    setReceipts(latest);
  }

  function clearReceiptsHistory() {
    saveReceipts([]);
    setReceipts([]);
    setActiveReceipt(null);
    setShowReceipt(false);
  }

  function updateReceiptNote(receiptId: string, note: string) {
    const all = loadReceipts();
    const idx = all.findIndex((r) => r.id === receiptId);
    if (idx < 0) return;

    const updated: TxReceipt = {
      ...all[idx],
      note: note.trim() ? note.trim() : undefined,
    };

    upsertReceipt(updated);
    setReceipts(loadReceipts());
    setActiveReceipt((prev) => (prev?.id === receiptId ? updated : prev));
  }

  function resetForNewPayment() {
    setRecipient("");
    setAmount("");
    setTxNote("");

    setTxStage("idle");
    setTxSig(null);
    setTxError(null);
    setIsSending(false);

    setShowReceipt(false);
    setActiveReceipt(null);

    setReceiptCopied(false);
    setSigCopied(false);
    setReceiptNoteDraft("");
    setNoteSavedTick(false);
  }

  const receiptAmountDisplay = useMemo(() => {
    if (!activeReceipt) return "—";
    const s = (activeReceipt.amountUi ?? "").trim();
    if (!s) return "—";
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return formatUsd(n);
    return s;
  }, [activeReceipt]);

  const receiptTokenDisplay = useMemo(() => {
    if (!activeReceipt) return "USDC";
    return activeReceipt.tokenSymbol ?? "USDC";
  }, [activeReceipt]);

  // --------------------
  // REQUEST PAYMENT LINK (generator + copy + QR)
  // --------------------
  const [origin, setOrigin] = useState<string>("");
  const [requestAmount, setRequestAmount] = useState<string>("");
  const [copied, setCopied] = useState(false);

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

  useEffect(() => {
    if (!requestLink) setShowRequestQr(false);
  }, [requestLink]);

  // --------------------
  // SHAREABLE PAY LINK PREFILL
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

  // Load contacts
  useEffect(() => {
    const initial = loadContacts();
    setContacts(initial);
  }, []);

  // Init + load receipts
  useEffect(() => {
    ensureReceiptsStore();
    const initial = loadReceipts();
    setReceipts(initial);
  }, []);

  // Keep note draft in sync when opening receipt
  useEffect(() => {
    if (!activeReceipt) {
      setReceiptNoteDraft("");
      return;
    }
    setReceiptNoteDraft(activeReceipt.note ?? "");
    setNoteSavedTick(false);
  }, [activeReceipt]);

  // Auto-open receipt when confirmed/failed
  useEffect(() => {
    if (!activeReceipt) return;
    if (
      activeReceipt.status === "confirmed" ||
      activeReceipt.status === "failed"
    ) {
      setShowReceipt(true);
    }
  }, [activeReceipt]);

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

  const selectedContact = useMemo(() => {
    const r = recipient.trim().toLowerCase();
    if (!r) return null;
    return contacts.find((c) => c.address.trim().toLowerCase() === r) ?? null;
  }, [contacts, recipient]);

  function receiptBadgeClasses(status: TxReceiptStatus) {
    if (status === "confirmed")
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    if (status === "failed")
      return "border-red-400/30 bg-red-400/10 text-red-200";
    if (status === "confirming")
      return "border-white/15 bg-white/5 text-zinc-200";
    return "border-white/10 bg-white/5 text-zinc-300";
  }

  function receiptStatusLabel(status: TxReceiptStatus) {
    if (status === "confirmed") return "Confirmed";
    if (status === "failed") return "Failed";
    if (status === "confirming") return "Confirming";
    return "Submitted";
  }

  function receiptAmountPretty(amountUi: string) {
    const s = (amountUi ?? "").trim();
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return formatUsd(n);
    return s || "—";
  }

  const filteredReceipts = useMemo(() => {
    const q = receiptSearch.trim().toLowerCase();

    function matchesFilter(r: TxReceipt) {
      if (receiptFilter === "all") return true;
      if (receiptFilter === "confirmed") return r.status === "confirmed";
      if (receiptFilter === "failed") return r.status === "failed";
      // pending
      return r.status === "submitted" || r.status === "confirming";
    }

    function matchesQuery(r: TxReceipt) {
      if (!q) return true;
      const hay = [
        r.to,
        r.from,
        r.sig ?? "",
        r.amountUi,
        r.note ?? "",
        r.status,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    }

    return receipts.filter((r) => matchesFilter(r) && matchesQuery(r));
  }, [receipts, receiptSearch, receiptFilter]);

  const recentReceipts = useMemo(
    () => filteredReceipts.slice(0, 10),
    [filteredReceipts]
  );

  const onSendUsdc = async () => {
    const from = publicKey?.toBase58() ?? "";
    const to = recipient.trim();
    const amountUi = amount.trim();
    const note = txNote.trim();

    const receiptId = makeId();
    const receiptDraft: TxReceipt = {
      id: receiptId,
      sig: null,
      createdAt: Date.now(),
      cluster: "devnet",
      status: "submitted",
      amountUi,
      tokenSymbol: "USDC",
      from,
      to,
      explorerUrl: null,
      note: note ? note : undefined,
    };

    try {
      setTxError(null);
      setTxSig(null);
      setTxStage("signing");
      setIsSending(true);

      upsertReceipt(receiptDraft);
      setReceipts(loadReceipts());
      setActiveReceipt(receiptDraft);

      const { signature, blockhash, lastValidBlockHeight } =
        await sendUsdcDevnet({
          connection,
          sender: publicKey!,
          recipient: new PublicKey(to),
          amountUi,
          signTransaction: signTransaction!,
        });

      setTxSig(signature);
      setTxStage("confirming");

      const withSig: TxReceipt = {
        ...receiptDraft,
        sig: signature,
        status: "confirming",
        explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      };

      upsertReceipt(withSig);
      setReceipts(loadReceipts());
      setActiveReceipt(withSig);

      const conf = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      if (conf.value.err) throw new Error("Transaction failed");

      const confirmed: TxReceipt = {
        ...withSig,
        status: "confirmed",
      };

      upsertReceipt(confirmed);
      setReceipts(loadReceipts());
      setActiveReceipt(confirmed);

      setTxStage("confirmed");
      refreshBalances();
    } catch (e: any) {
      setTxStage("failed");
      setTxError(e?.message ?? "Send failed");

      const failed: TxReceipt = {
        ...receiptDraft,
        status: "failed",
      };

      upsertReceipt(failed);
      setReceipts(loadReceipts());
      setActiveReceipt(failed);
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

  const usdcCash = usdcBalance === null ? "—" : formatUsd(usdcBalance);
  const solPrecise = solBalance === null ? "—" : solBalance.toFixed(4);

  // CONTACTS helpers
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
      const exists = prev.some((c) => c.address.toLowerCase() === addrLower);

      const next = exists ? prev : [newContact, ...prev];
      saveContacts(next);
      return next;
    });

    setContactName("");
  }

  return (
    <main className="min-h-screen text-white bg-black relative">
      {/* Premium background layers */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_20%_10%,rgba(120,80,255,.20),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_80%_20%,rgba(255,210,120,.14),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_50%_90%,rgba(70,140,255,.16),transparent_60%)]" />
        <div className="absolute inset-0 opacity-30 bg-[linear-gradient(to_right,rgba(255,255,255,.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,.06)_1px,transparent_1px)] bg-[size:64px_64px]" />
      </div>

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
                <div className="text-center space-y-1">
                  <p className="text-sm text-zinc-400">Connected Wallet</p>
                  <p className="font-mono text-lg">
                    {shortAddr(publicKey.toBase58())}
                  </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
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

                {mounted ? (
                  <QrScanButton
                    mode="panel"
                    validate={(v) => isValidSolanaAddress(v.trim())}
                    onScan={(value) => setRecipient(value.trim())}
                    disabled={!connected || isBusy}
                  />
                ) : null}

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
                  className="w-full mt-2 rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
                  inputMode="decimal"
                  disabled={isBusy}
                />

                <label className="mt-4 block text-xs text-zinc-400">
                  Note (optional)
                </label>
                <input
                  value={txNote}
                  onChange={(e) => setTxNote(e.target.value)}
                  placeholder='e.g., "Lunch"'
                  className="w-full mt-2 mb-4 rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
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

                {/* RECEIPT HISTORY */}
                <div className="mt-5 rounded-2xl border border-white/10 bg-black/30 overflow-hidden">
                  <div className="px-4 py-3 border-b border-white/10">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white">
                          Receipt History
                        </div>
                        <div className="mt-0.5 text-xs text-zinc-400">
                          Last 10 (filtered) on this device
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={refreshReceiptsFromStorage}
                          className="rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 hover:bg-white/10"
                        >
                          Refresh
                        </button>

                        <button
                          type="button"
                          onClick={clearReceiptsHistory}
                          disabled={receipts.length === 0}
                          className="rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Clear receipt history on this device"
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="text-xs text-zinc-400">Search</label>
                        <input
                          value={receiptSearch}
                          onChange={(e) => setReceiptSearch(e.target.value)}
                          placeholder="Search by address, tx, note…"
                          className="w-full mt-2 rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
                        />
                      </div>

                      <div className="sm:col-span-1">
                        <label className="text-xs text-zinc-400">Filter</label>
                        <select
                          value={receiptFilter}
                          onChange={(e) =>
                            setReceiptFilter(e.target.value as any)
                          }
                          className="w-full mt-2 rounded-lg bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20"
                        >
                          <option value="all">All</option>
                          <option value="confirmed">Confirmed</option>
                          <option value="pending">Pending</option>
                          <option value="failed">Failed</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {recentReceipts.length > 0 ? (
                    <div className="divide-y divide-white/10">
                      {recentReceipts.map((r) => {
                        const amountPretty = receiptAmountPretty(r.amountUi);
                        const toShort = shortMid(r.to, 7, 7);

                        return (
                          <div
                            key={r.id}
                            className="px-4 py-3 hover:bg-white/[0.04]"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    className={[
                                      "text-[11px] px-2 py-0.5 rounded-full border",
                                      receiptBadgeClasses(r.status),
                                    ].join(" ")}
                                  >
                                    {receiptStatusLabel(r.status)}
                                  </span>

                                  <div className="text-sm font-semibold text-white truncate">
                                    {amountPretty}{" "}
                                    <span className="text-white/60 font-semibold">
                                      USDC
                                    </span>
                                  </div>
                                </div>

                                <div className="mt-1 text-xs text-zinc-400">
                                  To:{" "}
                                  <span className="font-mono text-zinc-200">
                                    {toShort}
                                  </span>
                                  <span className="mx-2 text-zinc-600">•</span>
                                  {fmtWhen(r.createdAt)}
                                </div>

                                {r.note ? (
                                  <div className="mt-1 text-[11px] text-zinc-300">
                                    Note:{" "}
                                    <span className="text-white/80 font-semibold">
                                      {r.note}
                                    </span>
                                  </div>
                                ) : null}

                                {r.sig ? (
                                  <div className="mt-1 text-[11px] text-zinc-500 font-mono break-all">
                                    Tx: {shortMid(r.sig, 10, 10)}
                                  </div>
                                ) : (
                                  <div className="mt-1 text-[11px] text-zinc-500">
                                    Tx: Pending signature…
                                  </div>
                                )}
                              </div>

                              <div className="flex flex-col gap-2 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveReceipt(r);
                                    setShowReceipt(true);
                                  }}
                                  className="rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 hover:bg-white/10"
                                >
                                  Open
                                </button>

                                <button
                                  type="button"
                                  disabled={!r.sig}
                                  onClick={async () => {
                                    if (!r.sig) return;
                                    await copyText(r.sig);
                                  }}
                                  className="rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  Copy Tx
                                </button>

                                <a
                                  href={r.explorerUrl ?? "#"}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={[
                                    "rounded-lg px-3 py-2 text-xs text-center border",
                                    r.explorerUrl
                                      ? "bg-white text-black border-white/10 hover:opacity-90"
                                      : "bg-white/10 text-white/40 border-white/10 pointer-events-none",
                                  ].join(" ")}
                                >
                                  Explorer
                                </a>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="px-4 py-4 text-sm text-zinc-400">
                      No receipts match this search/filter yet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        ) : (
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

      {/* RECEIPT MODAL */}
      {showReceipt && activeReceipt && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/70"
            onClick={() => setShowReceipt(false)}
            aria-label="Close receipt"
          />

          <div className="absolute inset-0 flex items-end sm:items-center justify-center p-0 sm:p-6">
            <div className="w-full sm:max-w-md">
              <div className="rounded-t-3xl sm:rounded-2xl border border-white/10 bg-black/80 backdrop-blur-xl shadow-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">
                      Transaction Receipt
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-400">
                      {fmtWhen(activeReceipt.createdAt)}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={[
                        "text-[11px] px-2 py-1 rounded-full border",
                        activeReceipt.status === "confirmed"
                          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                          : activeReceipt.status === "failed"
                          ? "border-red-400/30 bg-red-400/10 text-red-200"
                          : "border-white/10 bg-white/5 text-zinc-200",
                      ].join(" ")}
                    >
                      {activeReceipt.status === "confirmed"
                        ? "Confirmed"
                        : activeReceipt.status === "failed"
                        ? "Failed"
                        : activeReceipt.status === "confirming"
                        ? "Confirming"
                        : "Submitted"}
                    </span>

                    <button
                      type="button"
                      onClick={() => setShowReceipt(false)}
                      className="rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 hover:bg-white/10"
                    >
                      Close
                    </button>
                  </div>
                </div>

                <div className="px-5 py-5">
                  <div className="text-center">
                    <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                      Amount
                    </div>
                    <div className="mt-2 text-4xl font-extrabold tracking-tight text-white">
                      {receiptAmountDisplay}
                      <span className="text-white/60 text-base font-semibold ml-2">
                        {receiptTokenDisplay}
                      </span>
                    </div>
                  </div>

                  <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] overflow-hidden">
                    <div className="px-4 py-3 border-b border-white/10">
                      <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                        To
                      </div>
                      <div className="mt-1 text-sm text-white font-mono break-all">
                        {activeReceipt.to
                          ? shortMid(activeReceipt.to, 10, 10)
                          : "—"}
                      </div>
                    </div>

                    <div className="px-4 py-3 border-b border-white/10">
                      <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                        From
                      </div>
                      <div className="mt-1 text-sm text-white font-mono break-all">
                        {activeReceipt.from
                          ? shortMid(activeReceipt.from, 10, 10)
                          : "—"}
                      </div>
                    </div>

                    <div className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                            Transaction ID
                          </div>
                          <div className="mt-1 text-xs text-zinc-300 font-mono break-all">
                            {activeReceipt.sig
                              ? shortMid(activeReceipt.sig, 12, 12)
                              : "Pending signature…"}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={!activeReceipt.sig}
                          onClick={async () => {
                            if (!activeReceipt.sig) return;
                            const ok = await copyText(activeReceipt.sig);
                            if (ok) {
                              setSigCopied(true);
                              window.setTimeout(() => setSigCopied(false), 1200);
                            }
                          }}
                          className="rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {sigCopied ? "Copied ✓" : "Copy"}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Notes */}
                  <div className="mt-4">
                    <label className="text-xs text-zinc-400">Note</label>
                    <textarea
                      value={receiptNoteDraft}
                      onChange={(e) => setReceiptNoteDraft(e.target.value)}
                      placeholder='e.g., "Lunch", "Gas", "Invoice #124"'
                      className="w-full mt-2 rounded-xl bg-black/40 border border-white/10 p-3 text-sm outline-none focus:border-white/20 min-h-[86px]"
                    />

                    <div className="mt-2 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          updateReceiptNote(activeReceipt.id, receiptNoteDraft);
                          setNoteSavedTick(true);
                          window.setTimeout(() => setNoteSavedTick(false), 1200);
                        }}
                        className="rounded-xl px-4 py-3 text-sm font-semibold bg-white/5 border border-white/10 hover:bg-white/10"
                      >
                        {noteSavedTick ? "Saved ✓" : "Save Note"}
                      </button>

                      <span className="text-[11px] text-zinc-500">
                        Notes save locally (this device)
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={async () => {
                        const text = activeReceipt.explorerUrl ?? "";
                        if (!text) return;
                        const ok = await copyText(text);
                        if (ok) {
                          setReceiptCopied(true);
                          window.setTimeout(
                            () => setReceiptCopied(false),
                            1200
                          );
                        }
                      }}
                      disabled={!activeReceipt.explorerUrl}
                      className="rounded-xl px-4 py-3 text-sm font-semibold bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {receiptCopied ? "Link Copied ✓" : "Copy Link"}
                    </button>

                    <a
                      href={activeReceipt.explorerUrl ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className={[
                        "rounded-xl px-4 py-3 text-sm font-semibold text-center",
                        activeReceipt.explorerUrl
                          ? "bg-white text-black hover:opacity-90"
                          : "bg-white/10 text-white/40 pointer-events-none",
                      ].join(" ")}
                    >
                      View on Explorer
                    </a>
                  </div>

                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={resetForNewPayment}
                      className="w-full rounded-xl px-4 py-3 text-sm font-semibold bg-emerald-500/20 border border-emerald-400/30 text-emerald-100 hover:bg-emerald-500/25"
                    >
                      New Payment
                    </button>
                  </div>

                  <div className="mt-4 text-center text-[11px] text-zinc-500">
                    UTILIZAP • {activeReceipt.cluster}
                  </div>
                </div>

                <div className="sm:hidden pb-3">
                  <div className="mx-auto h-1.5 w-12 rounded-full bg-white/15" />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Complete ✓ pop animation */}
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
