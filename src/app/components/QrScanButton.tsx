"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  onScan: (value: string) => void;
  validate?: (value: string) => boolean;
  disabled?: boolean;

  /** "button" renders the scan button, "panel" renders the scanner panel (when open) */
  mode?: "button" | "panel";
};

const CHANNEL = "uz:qr:toggle";

function emitToggle(open: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHANNEL, { detail: { open } }));
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
            const value = (raw || "").trim();
            if (!value) return;

            if (validate && !validate(value)) {
              setErr("That QR doesn’t look like a valid Solana address.");
              return;
            }

            await stopScanner();
            emitToggle(false);
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
          <div className="text-xs text-white/80">Scan recipient QR</div>
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
          Tip: Use QR codes that contain a plain Solana address.
        </div>
      </div>
    </div>
  );
}
