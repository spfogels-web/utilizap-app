"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  onScan: (value: string) => void;

  /**
   * Optional: keep your existing validate hook, but we will run it on the
   * normalized *recipient address* (not the raw QR string).
   */
  validate?: (value: string) => boolean;

  disabled?: boolean;

  /** "button" renders the scan button, "panel" renders the scanner panel (when open) */
  mode?: "button" | "panel";
};

const CHANNEL = "uz:qr:toggle";
const AMOUNT_CHANNEL = "uz:qr:amount"; // optional: listen elsewhere to auto-fill amount

function emitToggle(open: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHANNEL, { detail: { open } }));
}

function emitAmount(amount: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AMOUNT_CHANNEL, { detail: { amount } }));
}

/**
 * Practical Solana base58 address check (no external deps).
 * Pubkeys are 32 bytes => base58 strings typically 32–44 chars.
 */
function isLikelySolanaAddress(v: string) {
  const s = (v || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

/**
 * Extract recipient (+ optional amount) from scanned QR.
 * Supports:
 *  1) Plain address: "AKFwMNNV..."
 *  2) UTILIZAP request links:
 *       - https://app.utilizap.io/?to=<address>&amount=25
 *       - https://app.utilizap.io/request?to=<address>&amount=25
 *     (also supports aliases: recipient/address)
 *  3) Solana Pay URI (optional support):
 *       - solana:<address>?amount=25&...
 */
function parseScannedValue(raw: string): {
  ok: boolean;
  recipient?: string;
  amount?: string;
  reason?: string;
} {
  const value = (raw || "").trim();
  if (!value) return { ok: false, reason: "Empty QR value." };

  // 1) Plain address
  if (isLikelySolanaAddress(value)) {
    return { ok: true, recipient: value };
  }

  // 2) Solana Pay URI (optional, harmless to support)
  if (value.toLowerCase().startsWith("solana:")) {
    const after = value.slice("solana:".length);
    const [addrPart, queryPart] = after.split("?");
    const addr = (addrPart || "").trim();

    if (isLikelySolanaAddress(addr)) {
      let amount: string | undefined;
      if (queryPart) {
        const params = new URLSearchParams(queryPart);
        amount = params.get("amount") || undefined;
      }
      return { ok: true, recipient: addr, amount };
    }
  }

  // 3) UTILIZAP request link (URL)
  try {
    const url = new URL(value);

    // Accept your domain; allow staging/subdomains if you ever use them
    const host = (url.host || "").toLowerCase();
    const isUtilizap =
      host === "app.utilizap.io" ||
      host.endsWith(".utilizap.io") ||
      host === "utilizap.io" ||
      host.endsWith(".utilizap.io");

    if (!isUtilizap) {
      // It might still be a URL someone uses, but we only want ours here
      return { ok: false, reason: "Not a UTILIZAP link or Solana address." };
    }

    const recipient =
      url.searchParams.get("to") ||
      url.searchParams.get("recipient") ||
      url.searchParams.get("address") ||
      "";

    const amount =
      url.searchParams.get("amount") ||
      url.searchParams.get("amt") ||
      "";

    if (!recipient || !isLikelySolanaAddress(recipient)) {
      return { ok: false, reason: "UTILIZAP link missing a valid ?to= address." };
    }

    return {
      ok: true,
      recipient,
      amount: amount || undefined,
    };
  } catch {
    // not a URL
  }

  return { ok: false, reason: "QR not recognized. Use a Solana address or UTILIZAP request QR." };
}

export default function QrScanButton({
  onScan,
  validate,
  disabled,
  mode = "button",
}: Props) {
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
    // Only the panel instance should start camera/scanner
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
            const scanned = (raw || "").trim();
            if (!scanned) return;

            const parsed = parseScannedValue(scanned);
            if (!parsed.ok || !parsed.recipient) {
              setErr(parsed.reason || "Invalid QR.");
              return;
            }

            // Validate the recipient address (not the raw link)
            if (validate && !validate(parsed.recipient)) {
              setErr("That QR doesn’t contain a valid Solana address.");
              return;
            }

            await stopScanner();
            emitToggle(false);

            // ✅ Set recipient
            onScan(parsed.recipient);

            // ✅ Optional: auto-fill amount if present in UTILIZAP link / Solana Pay
            if (parsed.amount) {
              emitAmount(parsed.amount);
            }
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

        if (!alive) {
          await stopScanner();
        }
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

  // ✅ BUTTON MODE — compact, single-line fit
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

  // ✅ PANEL MODE (only renders when open)
  if (!open) return null;

  return (
    <div className="mt-3 mb-4 w-full flex justify-center">
      <div className="relative w-full max-w-[440px] aspect-square rounded-2xl border border-white/10 bg-black/60 overflow-hidden">
        {/* Header */}
        <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between">
          <div className="text-xs text-white/80">Scan QR</div>
          <button
            type="button"
            onClick={async () => {
              await stopScanner();
              emitToggle(false);
            }}
            className="h-8 w-8 rounded-full border border-white/10 bg-black/50 text-white/80 hover:text-white"
            aria-label="Close scanner"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Video */}
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          muted
          playsInline
        />

        {/* Subtle frame overlay */}
        <div
          className="absolute inset-0"
          aria-hidden="true"
          style={{
            boxShadow: "inset 0 0 0 2px rgba(255,255,255,.06)",
          }}
        />
        <div
          className="absolute inset-0 pointer-events-none"
          aria-hidden="true"
          style={{
            background:
              "radial-gradient(closest-side, transparent 62%, rgba(0,0,0,.35) 100%)",
          }}
        />

        {/* Error + tip */}
        {err && (
          <div className="absolute left-3 right-3 bottom-10 z-10 text-[11px] text-red-300">
            {err}
          </div>
        )}
        <div className="absolute left-3 right-3 bottom-3 z-10 text-[11px] text-white/70">
          Tip: Scan a plain Solana address OR a UTILIZAP request QR (app.utilizap.io with <span className="text-white/90">?to=</span>).
        </div>
      </div>
    </div>
  );
}
