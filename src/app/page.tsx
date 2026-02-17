"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import QRCode from "qrcode";

import { getSolBalance, getSplTokenBalance } from "./lib/balances";
import { sendUsdcDevnet, isValidSolanaAddress } from "./lib/transfer";
import { heliusAddressTransactions } from "./lib/helius";

import QrScanButton from "./components/QrScanButton";
import ReceiveQr from "./components/ReceiveQr";

/**
 * ✅ Devnet USDC mint (Helius tokenTransfers uses mint address)
 * This is standard for Solana devnet USDC.
 */
const USDC_MINT_DEVNET =
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// ✅ QR scanner amount auto-fill channel (emitted by QrScanButton when scanning UTILIZAP request QR)
const UZ_QR_AMOUNT_EVENT = "uz:qr:amount";
const UZ_QR_NOTE_EVENT = "uz:qr:note";

function shortAddr(address: string) {
  return address.slice(0, 4) + "..." + address.slice(-4);
}

function shortMid(s: string, head = 6, tail = 6) {
  if (!s) return "—";
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

type TxStage =
  | "idle"
  | "signing"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "failed";

// --------------------
// RECEIPTS (local + helius)
// --------------------
type TxReceiptStatus = "submitted" | "confirming" | "confirmed" | "failed";
type TxReceiptDirection = "sent" | "received";

type TxReceipt = {
  id: string;
  sig: string | null;
  createdAt: number;

  cluster: "devnet" | "mainnet-beta";
  status: TxReceiptStatus;

  direction: TxReceiptDirection;

  amountUi: string;
  tokenSymbol: "USDC";

  from: string;
  to: string;

  explorerUrl: string | null;
  note?: string;
};

const RECEIPTS_KEY = "uz_receipts_v2";

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
      .map((r) => {
        const dir: TxReceiptDirection =
          r.direction === "received" || r.direction === "sent"
            ? r.direction
            : "sent";

        return {
          id: r.id,
          sig: r.sig ?? null,
          createdAt: r.createdAt,
          cluster: r.cluster,
          status: r.status,
          direction: dir,
          amountUi: String(r.amountUi ?? "").trim(),
          tokenSymbol: "USDC" as const,
          from: String(r.from ?? "").trim(),
          to: String(r.to ?? "").trim(),
          explorerUrl: typeof r.explorerUrl === "string" ? r.explorerUrl : null,
          note: typeof r.note === "string" ? r.note : undefined,
        };
      });
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

// NEW: keep "last used" separately so your existing contacts keep working
type ContactMetaStore = Record<string, { lastUsedAt: number }>;
const CONTACTS_META_KEY = "uz_contacts_meta_v1";

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

function safeParseMeta(raw: string | null): ContactMetaStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: ContactMetaStore = {};
    for (const [k, v] of Object.entries(parsed)) {
      const lastUsedAt = (v as any)?.lastUsedAt;
      if (typeof lastUsedAt === "number" && Number.isFinite(lastUsedAt)) {
        out[k] = { lastUsedAt };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function loadContactsMeta(): ContactMetaStore {
  if (typeof window === "undefined") return {};
  return safeParseMeta(window.localStorage.getItem(CONTACTS_META_KEY));
}

function saveContactsMeta(next: ContactMetaStore) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONTACTS_META_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function touchContactMeta(id: string) {
  const meta = loadContactsMeta();
  meta[id] = { lastUsedAt: Date.now() };
  saveContactsMeta(meta);
}

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    // @ts-ignore
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// ✅ FIX: Helius Enhanced tx objects don't guarantee `err` exists on your type.
// We safely read error flags using `any` and a few common shapes.
function heliusHasError(tx: unknown): boolean {
  const t = tx as any;
  return Boolean(t?.transactionError || t?.err || t?.meta?.err);
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

  const [receiptNoteDraft, setReceiptNoteDraft] = useState<string>("");
  const [noteSavedTick, setNoteSavedTick] = useState(false);

  // Receipt history controls
  const [receiptSearch, setReceiptSearch] = useState("");
  const [receiptFilter, setReceiptFilter] = useState<
    "all" | "confirmed" | "pending" | "failed"
  >("all");
  const [receiptTab, setReceiptTab] = useState<"all" | "sent" | "received">(
    "all"
  );

  const [isHeliusSyncing, setIsHeliusSyncing] = useState(false);
  const lastHeliusSyncRef = useRef<string>("");

  // Contacts
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactName, setContactName] = useState("");

  // Cash App / Venmo-style contact picker
  const [contactsOpen, setContactsOpen] = useState(false);
  const [contactSearchQuery, setContactSearchQuery] = useState("");

  // --------------------
  // ✅ PREVIEW TRANSACTION (before Phantom)
  // --------------------
  const [showPreview, setShowPreview] = useState(false);
  const [previewAck, setPreviewAck] = useState(false);
  const [previewFeeText, setPreviewFeeText] = useState<string>("—");
  const [previewFeeLoading, setPreviewFeeLoading] = useState(false);
  const [previewWarn, setPreviewWarn] = useState<string | null>(null);

  const explorerUrl = txSig
    ? `https://explorer.solana.com/tx/${txSig}?cluster=devnet`
    : null;

  // Hydration-safe UI gate
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // ✅ NEW: Handle scan results that may be:
  // - A raw Solana address
  // - A UTILIZAP request URL like https://app.utilizap.io/?to=...&amount=...&note=...
  function applyScanValue(rawValue: string) {
    const value = String(rawValue ?? "").trim();
    if (!value) return;

    // If it's a URL, parse query params and fill recipient/amount/note
    if (/^https?:\/\//i.test(value)) {
      try {
        const u = new URL(value);
        const to = (u.searchParams.get("to") ?? "").trim();
        const amt = (u.searchParams.get("amount") ?? "").trim();
        const note = (u.searchParams.get("note") ?? "").trim();

        let did = false;

        if (to && isValidSolanaAddress(to)) {
          setRecipient(to);
          did = true;
        }

        if (amt) {
          const n = Number(amt);
          if (Number.isFinite(n) && n > 0) {
            setAmount(amt);
            did = true;
          }
        }

        if (note) {
          setTxNote(note);
          did = true;
        }

        // If it WAS a URL but didn't have our params, don't block fallback
        if (did) return;
      } catch {
        // fall through to address handling
      }
    }

    // Fallback: treat scan as a plain address
    if (isValidSolanaAddress(value)) {
      setRecipient(value);
    }
  }

  // ✅ Keep your existing QR amount event listener (backwards compatible)
  useEffect(() => {
    if (!mounted) return;

    const handler = (e: any) => {
      const raw = e?.detail?.amount;
      if (!raw) return;

      const clean = String(raw).trim();
      const n = Number(clean);
      if (!Number.isFinite(n) || n <= 0) return;

      setAmount(clean);
    };

    window.addEventListener(UZ_QR_AMOUNT_EVENT, handler as any);
    return () => window.removeEventListener(UZ_QR_AMOUNT_EVENT, handler as any);
  }, [mounted]);
  // ✅ Listen for NOTE emitted by UTILIZAP request QR
useEffect(() => {
  if (!mounted) return;

  const handler = (e: any) => {
    const raw = e?.detail?.note;
    if (!raw) return;

    const clean = String(raw).trim();
    if (!clean) return;

    setTxNote(clean);
  };

  window.addEventListener("uz:qr:note", handler as any);

  return () =>
    window.removeEventListener("uz:qr:note", handler as any);
}, [mounted]);


  function fmtWhen(ts: number) {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return "";
    }
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
    setReceipts(loadReceipts());
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

    // preview reset
    setShowPreview(false);
    setPreviewAck(false);
    setPreviewFeeText("—");
    setPreviewFeeLoading(false);
    setPreviewWarn(null);
  }

  const receiptAmountDisplay = useMemo(() => {
    if (!activeReceipt) return "—";
    const s = (activeReceipt.amountUi ?? "").trim();
    if (!s) return "—";
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return formatUsd(n);
    return s;
  }, [activeReceipt]);

  // --------------------
  // REQUEST PAYMENT LINK (generator + copy + QR)
  // --------------------
  const [origin, setOrigin] = useState<string>("");
  const [requestAmount, setRequestAmount] = useState<string>("");
  const [requestNote, setRequestNote] = useState<string>(""); // ✅ NEW
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

    const note = requestNote.trim();
    if (note) {
      // keep it reasonable so links don't get crazy long
      params.set("note", note.slice(0, 140));
    }

    return `${origin}/?${params.toString()}`;
  }, [origin, publicKey, requestAmount, requestNote]);

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
    const note = searchParams.get("note"); // ✅ NEW

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

    if (note) {
      const cleanNote = note.trim();
      if (cleanNote.length > 0) {
        setTxNote(cleanNote);
        didAnything = true;
      }
    }

    if (didAnything) setPrefillDone(true);
  }, [mounted, prefillDone, searchParams]);

  // Load contacts
  useEffect(() => {
    setContacts(loadContacts());
  }, []);

  // Init + load receipts
  useEffect(() => {
    ensureReceiptsStore();
    setReceipts(loadReceipts());
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
    return (
      contacts.find((c) => c.address.trim().toLowerCase() === r) ?? null
    );
  }, [contacts, recipient]);

  // Cash App-ish ordering: Recents first, then A-Z
  const contactsSorted = useMemo(() => {
    const meta = loadContactsMeta();
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });

    const list = [...contacts];
    list.sort((a, b) => {
      const aLast = meta[a.id]?.lastUsedAt ?? 0;
      const bLast = meta[b.id]?.lastUsedAt ?? 0;
      if (aLast !== bLast) return bLast - aLast;
      return collator.compare(a.name, b.name);
    });
    return list;
  }, [contacts]);

  const contactsFiltered = useMemo(() => {
    const q = contactSearchQuery.trim().toLowerCase();
    if (!q) return contactsSorted;

    return contactsSorted.filter((c) => {
      const hay = `${c.name} ${c.address}`.toLowerCase();
      return hay.includes(q);
    });
  }, [contactsSorted, contactSearchQuery]);

  const recentContactChips = useMemo(() => {
    // show up to 3 chips (Cash App-ish), the full list is inside the picker
    return contactsSorted.slice(0, 3);
  }, [contactsSorted]);

  function receiptBadgeClasses(status: TxReceiptStatus) {
    if (status === "confirmed")
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    if (status === "failed")
      return "border-red-400/30 bg-red-400/10 text-red-200";
    if (status === "confirming")
      return "border-white/15 bg-white/5 text-zinc-200";
    return "border-white/10 bg-white/5 text-zinc-300";
  }

  function directionBadgeClasses(direction: TxReceiptDirection) {
    if (direction === "received")
      return "border-sky-400/30 bg-sky-400/10 text-sky-200";
    return "border-amber-400/30 bg-amber-400/10 text-amber-200";
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

  /**
   * ✅ Helius import:
   * Pull last N txs and create receipts for USDC token transfers.
   */
  async function syncHeliusUsdcReceipts(walletAddr: string) {
    if (!walletAddr) return;

    const syncKey = `${walletAddr}`;
    if (lastHeliusSyncRef.current === syncKey) return;

    setIsHeliusSyncing(true);
    lastHeliusSyncRef.current = syncKey;

    try {
      const txs = await heliusAddressTransactions(walletAddr, { limit: 80 });
      const walletLower = walletAddr.toLowerCase();
      const mint = USDC_MINT_DEVNET;

      const bySig = new Map<string, TxReceipt>();

      for (const tx of Array.isArray(txs) ? txs : []) {
        const sig: string | undefined = (tx as any)?.signature;
        if (!sig) continue;

        const tokenTransfers = (tx as any)?.tokenTransfers || [];
        if (!Array.isArray(tokenTransfers) || tokenTransfers.length === 0)
          continue;

        // NET relative to wallet: + received, - sent
        let net = 0;
        let involved = false;

        let bestFrom = "";
        let bestTo = "";

        for (const t of tokenTransfers) {
          if (!t?.mint || String(t.mint) !== mint) continue;

          const raw = (t as any)?.tokenAmount ?? (t as any)?.amount ?? 0;

          let amt = 0;

          if (typeof raw === "number") amt = raw;
          else if (typeof raw === "string") amt = Number(raw);
          else if (raw && typeof raw === "object") {
            if (typeof raw.uiAmount === "number") amt = raw.uiAmount;
            else if (typeof raw.uiAmountString === "string")
              amt = Number(raw.uiAmountString);
            else if (typeof raw.amount === "string") {
              const decimals =
                typeof raw.decimals === "number" ? raw.decimals : 0;
              const intVal = Number(raw.amount);
              if (Number.isFinite(intVal))
                amt = intVal / Math.pow(10, decimals);
            }
          }

          if (!Number.isFinite(amt) || amt <= 0) continue;

          const fromAny = String(
            t?.fromUserAccount || t?.fromAccount || t?.fromTokenAccount || ""
          ).toLowerCase();

          const toAny = String(
            t?.toUserAccount || t?.toAccount || t?.toTokenAccount || ""
          ).toLowerCase();

          const looksOut = fromAny === walletLower;
          const looksIn = toAny === walletLower;

          if (looksIn || looksOut) involved = true;

          if (looksIn) {
            net += amt;
            bestFrom = String(
              t?.fromUserAccount || t?.fromAccount || t?.fromTokenAccount || ""
            );
            bestTo = walletAddr;
          } else if (looksOut) {
            net -= amt;
            bestFrom = walletAddr;
            bestTo = String(
              t?.toUserAccount || t?.toAccount || t?.toTokenAccount || ""
            );
          } else {
            involved = true;
            net += amt;
            bestFrom = String(
              t?.fromUserAccount || t?.fromAccount || t?.fromTokenAccount || ""
            );
            bestTo = walletAddr;
          }
        }

        if (!involved) continue;

        const direction: TxReceiptDirection = net >= 0 ? "received" : "sent";
        const amountAbs = Math.abs(net);

        const tsSeconds =
          (tx as any)?.timestamp ?? (tx as any)?.blockTime ?? null;

        const createdAt =
          typeof tsSeconds === "number" && tsSeconds > 0
            ? tsSeconds * 1000
            : Date.now();

        const status: TxReceiptStatus = heliusHasError(tx)
          ? "failed"
          : "confirmed";

        const id = `h_${sig}`;

        const r: TxReceipt = {
          id,
          sig,
          createdAt,
          cluster: "devnet",
          status,
          direction,
          amountUi: String(Number.isFinite(amountAbs) ? amountAbs : 0),
          tokenSymbol: "USDC",
          from: direction === "received" ? bestFrom || "" : walletAddr,
          to: direction === "received" ? walletAddr : bestTo || "",
          explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
        };

        bySig.set(sig, r);
      }

      if (bySig.size === 0) return;

      const existing = loadReceipts();
      const existingById = new Map(existing.map((r) => [r.id, r]));

      for (const r of bySig.values()) {
        const prev = existingById.get(r.id);
        const merged: TxReceipt = prev?.note ? { ...r, note: prev.note } : r;
        upsertReceipt(merged);
      }

      setReceipts(loadReceipts());
    } catch (e) {
      console.error("Helius sync failed:", e);
    } finally {
      setIsHeliusSyncing(false);
    }
  }

  // Auto-sync once per wallet connect
  useEffect(() => {
    if (!publicKey || !connected) return;

    (async () => {
      try {
        await syncHeliusUsdcReceipts(publicKey.toBase58());
      } catch (err) {
        console.error("Helius sync failed (effect):", err);
      }
    })();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, connected]);

  const filteredReceipts = useMemo(() => {
    const q = receiptSearch.trim().toLowerCase();

    function matchesFilter(r: TxReceipt) {
      if (receiptFilter === "all") return true;
      if (receiptFilter === "confirmed") return r.status === "confirmed";
      if (receiptFilter === "failed") return r.status === "failed";
      return r.status === "submitted" || r.status === "confirming";
    }

    function matchesTab(r: TxReceipt) {
      if (receiptTab === "all") return true;
      return r.direction === receiptTab;
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
        r.direction,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    }

    return receipts.filter(
      (r) => matchesFilter(r) && matchesTab(r) && matchesQuery(r)
    );
  }, [receipts, receiptSearch, receiptFilter, receiptTab]);

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
      direction: "sent",
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

      const confirmed: TxReceipt = { ...withSig, status: "confirmed" };

      upsertReceipt(confirmed);
      setReceipts(loadReceipts());
      setActiveReceipt(confirmed);

      setTxStage("confirmed");
      refreshBalances();

      // allow a re-sync later
      lastHeliusSyncRef.current = "";
    } catch (e: any) {
      setTxStage("failed");
      setTxError(e?.message ?? "Send failed");

      const failed: TxReceipt = { ...receiptDraft, status: "failed" };

      upsertReceipt(failed);
      setReceipts(loadReceipts());
      setActiveReceipt(failed);
    } finally {
      setIsSending(false);
    }
  };

  const isBusy =
    isSending ||
    txStage === "signing" ||
    txStage === "submitted" ||
    txStage === "confirming";

  const isConfirmed = txStage === "confirmed";

  const usdcCash = usdcBalance === null ? "—" : formatUsd(usdcBalance);
  const solPrecise = solBalance === null ? "—" : solBalance.toFixed(4);

  function chooseContact(c: Contact) {
    setRecipient(c.address);
    touchContactMeta(c.id);
    setContactsOpen(false);
    setContactSearchQuery("");
  }

  function deleteContact(id: string) {
    setContacts((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveContacts(next);

      // also clean meta
      const meta = loadContactsMeta();
      if (meta[id]) {
        delete meta[id];
        saveContactsMeta(meta);
      }

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

    // mark as used so it appears in recents immediately
    touchContactMeta(newContact.id);

    setContactName("");
  }

  const modalTitle = useMemo(() => {
    if (!activeReceipt) return "Transaction Receipt";
    return activeReceipt.direction === "received"
      ? "Payment Received"
      : "Payment Sent";
  }, [activeReceipt]);

  const modalAccent = useMemo(() => {
    if (!activeReceipt) return "border-white/10 bg-white/5 text-zinc-200";
    return activeReceipt.direction === "received"
      ? "border-sky-400/30 bg-sky-400/10 text-sky-200"
      : "border-amber-400/30 bg-amber-400/10 text-amber-200";
  }, [activeReceipt]);

  const receiptShareLink = useMemo(() => {
    if (!mounted || !activeReceipt?.to) return "";
    try {
      const o = window.location.origin;
      const params = new URLSearchParams();
      params.set("to", activeReceipt.to);

      const n = Number(activeReceipt.amountUi);
      if (Number.isFinite(n) && n > 0)
        params.set("amount", String(activeReceipt.amountUi));

      const note = (activeReceipt.note ?? "").trim();
      if (note) params.set("note", note.slice(0, 140));

      return `${o}/?${params.toString()}`;
    } catch {
      return "";
    }
  }, [mounted, activeReceipt]);

  // --------------------
  // ✅ PREVIEW helpers
  // --------------------
  const previewTo = useMemo(() => recipient.trim(), [recipient]);
  const previewFrom = useMemo(
    () => publicKey?.toBase58() ?? "",
    [publicKey]
  );
  const previewAmountPretty = useMemo(() => {
    const n = Number(amount);
    if (Number.isFinite(n) && n > 0) return formatUsd(n);
    return amount?.trim() ? amount.trim() : "—";
  }, [amount]);

  function openPreview() {
    setPreviewWarn(null);
    if (!canSend || isBusy) return;

    try {
      const from = previewFrom.trim();
      const to = previewTo.trim();
      if (from && to && from.toLowerCase() === to.toLowerCase()) {
        setPreviewWarn("You are sending to your own wallet address.");
      } else {
        setPreviewWarn(null);
      }
    } catch {
      setPreviewWarn(null);
    }

    setPreviewAck(false);
    setPreviewFeeText("—");
    setShowPreview(true);
  }

  async function estimateNetworkFee(): Promise<string> {
    try {
      if (!publicKey) return "—";
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      const tx = new Transaction({
        feePayer: publicKey,
        recentBlockhash: blockhash,
      });
      tx.add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: publicKey,
          lamports: 0,
        })
      );

      const msg = tx.compileMessage();
      const feeLamports = await connection.getFeeForMessage(msg, "confirmed");
      const lamports =
        typeof feeLamports?.value === "number" ? feeLamports.value : null;

      if (lamports === null) return "—";

      const sol = lamports / LAMPORTS_PER_SOL;
      const pretty =
        sol === 0 ? "0" : sol < 0.0001 ? sol.toFixed(6) : sol.toFixed(4);
      return `${pretty} SOL (est.)`;
    } catch {
      return "—";
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!showPreview) return;
      if (!publicKey) return;

      setPreviewFeeLoading(true);
      const fee = await estimateNetworkFee();
      if (!cancelled) {
        setPreviewFeeText(fee);
        setPreviewFeeLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPreview, publicKey]);

  async function continueToPhantom() {
    if (!previewAck) return;
    setShowPreview(false);

    window.setTimeout(() => {
      onSendUsdc();
    }, 30);
  }

  return (
    <main className="min-h-screen text-white bg-black relative uz-app">
      {/* UTILIZAP PURPLE/BLUE BACKGROUND */}
      <div className="pointer-events-none absolute inset-0 uz-bg" />

      <div className="relative mx-auto w-full max-w-5xl px-4 sm:px-6 py-8">
        {/* Header */}
        <header className="uz-shellHeader flex items-center justify-between gap-4 rounded-2xl px-4 sm:px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/brand/utilizap-logo.png"
              alt="UTILIZAP"
              draggable={false}
              className="h-10 w-auto select-none"
            />
            <div className="min-w-0">
              <div className="text-xs text-white/80 truncate">
                Non-custodial USDC wallet-to-wallet transfers on Solana
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex items-center gap-2 rounded-full uz-chip">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400/90" />
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
            <div className="uz-panel rounded-2xl p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-lg font-bold">Wallet</h2>
                <span className="text-xs text-white/70">
                  Secure • Non-custodial
                </span>
              </div>

              <div className="mt-4 rounded-xl uz-subpanel p-4 space-y-4">
                <div className="text-center space-y-1">
                  <p className="text-sm text-white/70">Connected Wallet</p>
                  <p className="font-mono text-lg text-white">
                    {shortAddr(publicKey.toBase58())}
                  </p>
                </div>

                <div className="rounded-2xl uz-card overflow-hidden">
                  <div className="px-4 py-4 border-b border-white/10">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[11px] uppercase tracking-wider text-white/70">
                          Available Balance
                        </p>
                        <p className="mt-1 text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                          {usdcCash}{" "}
                          <span className="text-white/70 text-base sm:text-lg font-semibold">
                            USDC
                          </span>
                        </p>
                        <p className="mt-1 text-sm text-white/60">
                          Ready to send
                        </p>
                      </div>

                      <div className="uz-orb" aria-hidden="true" />
                    </div>

                    <div className="mt-2 text-[11px] text-white/60">
                      USDC (devnet)
                    </div>
                  </div>

                  <div className="px-4 py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[11px] uppercase tracking-wider text-white/70">
                          Network Balance
                        </p>
                        <p className="mt-1 text-lg font-bold text-white">
                          {solPrecise}{" "}
                          <span className="text-white/70 font-semibold">
                            SOL
                          </span>
                        </p>
                        <p className="mt-1 text-sm text-white/60">
                          Used for network fees
                        </p>
                      </div>

                      <span className="text-xs px-3 py-1 rounded-full uz-chip">
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
            <div className="uz-panel rounded-2xl p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-lg font-bold">Send USDC</h2>
                <span className="text-xs text-white/70">Devnet</span>
              </div>

              <div className="mt-4">
                {/* Request payment link */}
                <div className="mb-5 rounded-2xl uz-subpanel p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-white">
                        Request Payment Link
                      </div>
                      <div className="mt-1 text-xs text-white/70">
                        Share a link that opens UTILIZAP pre-filled to pay you
                      </div>
                    </div>
                    <span className="text-[11px] px-2 py-1 rounded-full uz-chip">
                      Shareable
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-1">
                      <label className="text-xs text-white/70">
                        Amount (optional)
                      </label>
                      <input
                        value={requestAmount}
                        onChange={(e) => setRequestAmount(e.target.value)}
                        placeholder="e.g., 25"
                        className="uz-input w-full mt-2"
                        inputMode="decimal"
                        disabled={!mounted}
                      />
                    </div>

                    {/* ✅ NEW: request note */}
                    <div className="sm:col-span-2">
                      <label className="text-xs text-white/70">
                        Note (optional)
                      </label>
                      <input
                        value={requestNote}
                        onChange={(e) => setRequestNote(e.target.value)}
                        placeholder='e.g., "Lunch"'
                        className="uz-input w-full mt-2"
                        disabled={!mounted}
                      />
                      <div className="mt-2 text-[11px] text-white/60">
                        This will prefill the sender&apos;s Note field.
                      </div>
                    </div>

                    <div className="sm:col-span-3">
                      <label className="text-xs text-white/70">Link</label>
                      <div className="mt-2 flex items-center gap-3">
                        <input
                          id="uz-request-link"
                          value={requestLink || ""}
                          readOnly
                          className="uz-input w-full"
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

                      <div className="mt-2 text-[11px] text-white/60">
                        Opens:{" "}
                        <span className="text-white/80">
                          Recipient + Amount + Note
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
                        <span className="text-[11px] text-white/70">
                          Scan to open payment request
                        </span>
                      </div>

                      {showRequestQr && requestQr && (
                        <div className="mt-4 flex justify-center">
                          <div className="rounded-xl bg-black/40 p-3 border border-white/10">
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

                <label className="text-xs text-white/70">Recipient</label>

                {mounted ? (
                  <QrScanButton
                    mode="panel"
                    validate={(v) =>
                      isValidSolanaAddress(v.trim()) || /^https?:\/\//i.test(v)
                    }
                    onScan={(value) => applyScanValue(value)}
                    disabled={!connected || isBusy}
                  />
                ) : null}

                <div className="mt-2 mb-3 flex items-center gap-3">
                  <input
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder="Recipient Solana address"
                    className="uz-input w-full"
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
                      validate={(v) =>
                        isValidSolanaAddress(v.trim()) || /^https?:\/\//i.test(v)
                      }
                      onScan={(value) => applyScanValue(value)}
                      disabled={!connected || isBusy}
                    />
                  ) : (
                    <button type="button" className="uz-btn-secondary" disabled>
                      Scan
                    </button>
                  )}
                </div>

                {/* ... EVERYTHING ELSE BELOW IS UNCHANGED FROM YOUR FILE ... */}

                {/* Cash App / Venmo style: show ONLY a few "Recents" chips + a Contacts button */}
                <div className="mb-4 rounded-2xl uz-subpanel p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-white">
                        Contacts
                      </div>
                      <div className="mt-0.5 text-xs text-white/70">
                        Pick from unlimited saved contacts (Cash App style)
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setContactsOpen(true)}
                      disabled={isBusy}
                      className="uz-btn-secondary"
                      title="Open contacts"
                    >
                      📇 Contacts
                    </button>
                  </div>

                  {selectedContact ? (
                    <div className="mt-3 text-xs text-white/70">
                      Selected:{" "}
                      <span className="text-white font-semibold">
                        {selectedContact.name}
                      </span>
                      <span className="mx-2 text-white/40">•</span>
                      <span className="font-mono text-white/80">
                        {shortMid(selectedContact.address, 8, 8)}
                      </span>
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-white/60">
                      Tip: Save your frequent payees and choose them in one tap.
                    </div>
                  )}

                  {recentContactChips.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {recentContactChips.map((c) => {
                        const active =
                          recipient.trim().toLowerCase() ===
                          c.address.toLowerCase();
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => chooseContact(c)}
                            disabled={isBusy}
                            className={[
                              "rounded-full px-3 py-2 text-xs border transition",
                              active
                                ? "bg-white text-black border-white/10"
                                : "bg-white/5 border-white/10 hover:bg-white/10 text-white",
                            ].join(" ")}
                            title={c.address}
                          >
                            <span className="font-semibold">{c.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-white/70">
                      No contacts yet — add one below.
                    </div>
                  )}

                  <div className="mt-4">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-white/70">Quick add</p>
                      <p className="text-[11px] text-white/60">
                        Saved on this device
                      </p>
                    </div>

                    <div className="mt-2 flex flex-col sm:flex-row gap-3">
                      <input
                        value={contactName}
                        onChange={(e) => setContactName(e.target.value)}
                        placeholder="Name (e.g., Mike)"
                        className="uz-input w-full sm:flex-1"
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

                    <div className="mt-2 text-[11px] text-white/60">
                      Save the currently entered recipient address as a contact.
                    </div>
                  </div>
                </div>

                <label className="text-xs text-white/70">Amount</label>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Amount (USDC)"
                  className="uz-input w-full mt-2"
                  inputMode="decimal"
                  disabled={isBusy}
                />

                <label className="mt-4 block text-xs text-white/70">
                  Note (optional)
                </label>
                <input
                  value={txNote}
                  onChange={(e) => setTxNote(e.target.value)}
                  placeholder='e.g., "Lunch"'
                  className="uz-input w-full mt-2 mb-4"
                  disabled={isBusy}
                />

                {/* ... the rest of your component stays exactly as-is ... */}

                {/* (KEEP YOUR EXISTING JSX BELOW; unchanged) */}
                {/* NOTE: To keep this message readable, I didn’t re-paste the rest of the file here,
                   because nothing below this point affects the note prefill bug. */}
              </div>
            </div>
          </section>
        ) : (
          <section className="mt-6 uz-panel rounded-2xl p-8 sm:p-10 text-center">
            <div className="text-xs text-white/70">UTILIZAP • Devnet Preview</div>

            <h1 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight">
              Venmo-style USDC payments,
              <span className="block text-white/90">Non-custodial. Instant.</span>
            </h1>

            <p className="mt-4 max-w-2xl mx-auto text-sm sm:text-base text-white/80">
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

            <div className="mt-4 text-xs text-white/70">
              Utility first. Build first. Launch second.
            </div>
          </section>
        )}

        <footer className="mt-8 text-center text-xs text-white/60">
          UTILIZAP • Non-custodial payments • Devnet environment
        </footer>
      </div>

      {/* KEEP YOUR EXISTING MODALS/STYLES BELOW (unchanged) */}
      {/* ✅ CONTACTS PICKER MODAL ... */}
      {/* ✅ RECEIPT MODAL ... */}
      {/* ✅ PREVIEW MODAL ... */}
      {/* Complete ✓ pop animation ... */}
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
