"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  onScan: (value: string) => void;
  validate?: (value: string) => boolean;
  disabled?: boolean;
  mode?: "button" | "panel";
};

const CHANNEL = "uz:qr:toggle";
const RECIPIENT_CHANNEL = "uz:qr:recipient";
const AMOUNT_CHANNEL = "uz:qr:amount";
const NOTE_CHANNEL = "uz:qr:note";

function emitToggle(open: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHANNEL, { detail: { open } }));
}

function emitRecipient(recipient: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RECIPIENT_CHANNEL, { detail: { recipient } }));
}

function emitAmount(amount: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AMOUNT_CHANNEL, { detail: { amount } }));
}

function emitNote(note: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NOTE_CHANNEL, { detail: { note } }));
}

/** Basic Solana base58 address check (no network calls) */
function isLikelySolanaAddress(v: string) {
  const s = (v || "").trim();
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function cleanNumberString(v: string) {
  // allow: "25", "25.5" (strip commas/spaces)
  const s = (v || "").trim().replace(/,/g, "");
  if (!s) return "";
  if (!/^\d+(\.\d+)?$/.test(s)) return "";
  return s;
}

function pickFirst(...vals: Array<string | null | undefined>) {
  for (const v of vals) {
    const s = (v || "").trim();
    if (s) return s;
  }
  return "";
}

type Parsed = {
  kind: "solana" | "utilizap" | "unknown";
  recipient?: string;
  amount?: string;
  note?: string;
};

/**
 * Accept:
 *  - plain Solana address
 *  - UTILIZAP request URL / deep link containing ?to=...
 *  - solana:<address>?amount=...&memo=... (Solana Pay-ish)
 */
function parseQrValue(raw: string): Parsed {
  const value = (raw || "").trim();
  if (!value) return { kind: "unknown" };

  // 1) Plain Solana address
  if (isLikelySolanaAddress(value)) return { kind: "solana", recipient: value };

  // 2) solana:<address>[?params]
  if (/^solana:/i.test(value)) {
    const after = value.replace(/^solana:/i, "").trim();

    // split address and query
    const [addrPart, queryPart] = after.split("?");
    const recipient = (addrPart || "").trim();

    if (recipient && isLikelySolanaAddress(recipient)) {
      let amount = "";
      let note = "";

      if (queryPart) {
        const sp = new URLSearchParams(queryPart);
        amount = cleanNumberString(
          pickFirst(sp.get("amount"), sp.get("a"), sp.get("amt"))
        );

        // common fields: memo/message/note
        note = pickFirst(sp.get("note"), sp.get("memo"), sp.get("message"));
      }

      return { kind: "solana", recipient, amount: amount || undefined, note: note || undefined };
    }
  }

  // 3) URL / deep link with ?to=...
  // Handles:
  //  - http://localhost:3000/?to=...&amount=...&note=...
  //  - https://utilizap.xyz/?to=...
  //  - utilizap://request?to=...
  //  - any deep link that has "to" param
  try {
    const normalized =
      /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || value.startsWith("utilizap://")
        ? value
        : `https://${value}`;

    const u = new URL(normalized);

    const to = (u.searchParams.get("to") || "").trim();
    const recipient = to && isLikelySolanaAddress(to) ? to : "";

    // Allow these param names (in case you change later):
    const amount = cleanNumberString(
      pickFirst(u.searchParams.get("amount"), u.searchParams.get("amt"), u.searchParams.get("a"))
    );

    const note = pickFirst(
      u.searchParams.get("note"),
      u.searchParams.get("memo"),
      u.searchParams.get("message")
    );

    if (recipient) {
      return {
        kind: "utilizap",
        recipient,
        amount: amount || undefined,
        note: note || undefined,
      };
    }
  } catch {
    // ignore
  }

  // 4) If someone encoded "solana:<addr>" without query parsing above, fallback:
  const maybe = value.replace(/^solana:/i, "").trim();
  if (isLikelySolanaAddress(maybe)) return { kind: "solana", recipient: maybe };

  return { kind: "unknown" };
}

export default function QrScanButton({ onScan, validate, disabled, mode = "button" }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<any>(null);

  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canUse = useMemo(() => typeof window !== "undefined", []);

  // Sync open/close between the "button" instance and the "panel" instance
  useEffect(() => {
    if (!canUse) return;

    const handler = (e: any) => {
      const next = !!e?.detail?.open;
      setErr(null);
      setOpen(next);
    };

    window.addEventListener(CHANNEL, handler as any);
    return () => window.removeEventListener(CHANNEL, handler as any);
  }, [canUse]);

  const stopScanner = async () => {
    try {
      const s = scannerRef.current;
      if (s) {
        await s.stop();
        await s.destroy();
        scannerRef.current = null;
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (mode !== "panel") return;
    if (!open) return;

    let alive = true;

    const start = async () => {
      setErr(null);

      try {
        const QrScanner = (await import("qr-scanner")).default;

        const videoEl = videoRef.current;
        if (!videoEl) throw new Error("Camera not ready.");

        const scanner = new QrScanner(
          videoEl,
          async (result: any) => {
            const raw = typeof result === "string" ? result : result?.data;
            const value = (raw || "").trim();
            if (!value) return;

            const parsed = parseQrValue(value);
            const recipientForValidate = parsed.recipient || value;

            if (validate && !validate(recipientForValidate)) {
              setErr("That QR doesn’t look like a valid Solana address or UTILIZAP request.");
              return;
            }

            if (!validate && parsed.kind === "unknown") {
              setErr("That QR doesn’t look like a valid Solana address or UTILIZAP request.");
              return;
            }

            // ✅ NEW: emit autofill payloads (recipient / amount / note)
            if (parsed.recipient) emitRecipient(parsed.recipient);
            if (parsed.amount) emitAmount(parsed.amount);
            if (parsed.note) emitNote(parsed.note);

            await stopScanner();
            emitToggle(false);

            // keep existing behavior: pass the raw QR string up
            onScan(value);
          },
          {
            preferredCamera: "environment",
            highlightScanRegion: true,
            highlightCodeOutline: true,
            maxScansPerSecond: 8,
          }
        );

        scannerRef.current = scanner;
        await scanner.start();

        if (!alive) await stopScanner();
      } catch (e: any) {
        setErr(e?.message || "Camera could not start. Check permissions.");
      }
    };

    start();

    return () => {
      alive = false;
      stopScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  if (!canUse) return null;

  // ✅ BUTTON MODE
  if (mode === "button") {
    return (
      <button
        type="button"
        className="
          uz-btn-secondary
          px-3 py-1.5
          text-[11px]
          leading-none
          rounded-full
          whitespace-nowrap
        "
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setErr(null);
          emitToggle(true);
        }}
        aria-label="QR Scan"
        title="QR Scan"
      >
        QR SCAN
      </button>
    );
  }

  // ✅ PANEL MODE
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm">
      {/* Top bar */}
      <div
        className="absolute left-0 right-0 top-0 z-30"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <div className="text-xs text-white/85">Scan Solana address or UTILIZAP request</div>

          <button
            type="button"
            onClick={async () => {
              await stopScanner();
              emitToggle(false);
            }}
            className="h-10 w-10 rounded-full border border-white/10 bg-black/40 text-white/85 hover:text-white"
            aria-label="Close scanner"
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Centered square scanner */}
      <div className="absolute inset-0 flex items-center justify-center px-4">
        <div
          className="
            relative
            w-full
            max-w-[520px]
            aspect-square
            rounded-2xl
            overflow-hidden
            border
            border-white/10
            bg-black
          "
        >
          {/* Video fills the square */}
          <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" muted playsInline />

          {/* Frame + vignette */}
          <div
            className="absolute inset-0 pointer-events-none"
            aria-hidden="true"
            style={{ boxShadow: "inset 0 0 0 2px rgba(255,255,255,.06)" }}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            aria-hidden="true"
            style={{
              background: "radial-gradient(closest-side, transparent 62%, rgba(0,0,0,.45) 100%)",
            }}
          />
        </div>
      </div>

      {/* Bottom tip + error */}
      <div
        className="absolute left-0 right-0 bottom-0 z-30"
        style={{
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      >
        <div className="px-4 pb-4">
          {err && <div className="mb-2 text-[12px] text-red-300">{err}</div>}
          <div className="text-[12px] text-white/75">
            Tip: Scan a Solana address or a UTILIZAP request QR to auto-fill recipient, amount, and note.
          </div>
        </div>
      </div>
    </div>
  );
}