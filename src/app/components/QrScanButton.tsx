"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  onScan: (value: string) => void;
  validate?: (value: string) => boolean;
  disabled?: boolean;
};

export default function QrScanButton({ onScan, validate, disabled }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<any>(null);

  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);

  const canUse = useMemo(() => typeof window !== "undefined", []);

  useEffect(() => {
    if (!open) return;

    let alive = true;

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

    const start = async () => {
      setErr(null);
      setTorchOn(false);
      setHasTorch(false);

      try {
        const QrScanner = (await import("qr-scanner")).default;

        if (!alive) return;

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
            setOpen(false);
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

        try {
          const torch = await scanner.hasFlash();
          setHasTorch(!!torch);
        } catch {
          setHasTorch(false);
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
  }, [open]);

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

  const toggleTorch = async () => {
    try {
      const s = scannerRef.current;
      if (!s) return;
      const next = !torchOn;
      await s.toggleFlash();
      setTorchOn(next);
    } catch {
      setErr("Torch not available on this device.");
    }
  };

  if (!canUse) return null;

  return (
    <>
      <button
        type="button"
        className="uz-qr-btn"
        disabled={disabled}
        aria-disabled={disabled ? true : undefined}
        onClick={() => {
          if (disabled) return;
          setErr(null);
          setOpen(true);
        }}
        aria-label="Scan QR"
        title="Scan QR"
      >
        <svg
          className="uz-qr-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>

        <span className="uz-qr-text">Scan</span>
      </button>

      {open && (
        <div className="uz-qr-modal" role="dialog" aria-modal="true">
          <div
            className="uz-qr-backdrop"
            onClick={async () => {
              await stopScanner();
              setOpen(false);
            }}
          />
          <div className="uz-qr-sheet">
            <div className="uz-qr-head">
              <div className="uz-qr-title">Scan recipient QR</div>
              <button
                type="button"
                className="uz-qr-close"
                onClick={async () => {
                  await stopScanner();
                  setOpen(false);
                }}
                aria-label="Close scanner"
              >
                ✕
              </button>
            </div>

            <div className="uz-qr-video-wrap">
              <video ref={videoRef} className="uz-qr-video" muted playsInline />
              <div className="uz-qr-frame" aria-hidden="true" />
            </div>

            <div className="uz-qr-actions">
              <button
                type="button"
                className="uz-qr-action"
                onClick={async () => {
                  await stopScanner();
                  setOpen(false);
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                className="uz-qr-action uz-qr-action-primary"
                onClick={toggleTorch}
                disabled={!hasTorch}
                title={!hasTorch ? "Torch not supported" : "Toggle torch"}
              >
                {torchOn ? "Torch: On" : "Torch: Off"}
              </button>
            </div>

            {err && <div className="uz-qr-error">{err}</div>}
            <div className="uz-qr-tip">
              Tip: Use QR codes that contain a plain Solana address.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
