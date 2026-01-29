"use client";

import { useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";

type Props = {
  onResult: (text: string) => void;
};

export default function QrScanButton({ onResult }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);

  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    (async () => {
      try {
        setErr(null);
        const video = videoRef.current;
        if (!video) return;

        const scanner = new QrScanner(
          video,
          (result) => {
            if (cancelled) return;
            onResult(result.data);
            setOpen(false);
          },
          {
            highlightScanRegion: true,
            highlightCodeOutline: true,
            returnDetailedScanResult: true,
          }
        );

        scannerRef.current = scanner;
        await scanner.start();
      } catch (e: any) {
        setErr(e?.message ?? "Camera error");
      }
    })();

    return () => {
      cancelled = true;
      scannerRef.current?.stop();
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, [open, onResult]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg px-3 py-2 text-sm border border-white/10 bg-white/5 hover:bg-white/10"
      >
        Scan QR
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-black/60 backdrop-blur p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="font-semibold">Scan recipient QR</div>
              <button
                onClick={() => setOpen(false)}
                className="text-zinc-300 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="rounded-xl overflow-hidden border border-white/10 bg-black">
              <video ref={videoRef} className="w-full h-72 object-cover" />
            </div>

            {err && <div className="mt-3 text-xs text-red-400">{err}</div>}

            <div className="mt-3 text-xs text-zinc-400">
              Tip: QR should contain a Solana address or a solana: link.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
