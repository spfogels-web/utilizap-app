"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import QRCode from "qrcode";

type Props = {
  className?: string;
};

export default function ReceiveQr({ className }: Props) {
  const { publicKey, connected } = useWallet();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const address = useMemo(() => publicKey?.toBase58() ?? "", [publicKey]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setErr(null);
      setDataUrl(null);

      if (!connected || !address) return;

      try {
        const url = await QRCode.toDataURL(address, {
          margin: 1,
          width: 320,
          errorCorrectionLevel: "M",
        });

        if (!cancelled) setDataUrl(url);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? "Failed to generate QR");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [connected, address]);

  if (!connected) {
    return (
      <div className={className}>
        <div className="text-sm text-zinc-300">
          Connect a wallet to display your Receive QR code.
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">Receive</div>
          <div className="text-xs text-zinc-400">
            Let someone scan to pay your wallet
          </div>
        </div>

        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(address)}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 hover:bg-white/10"
        >
          Copy
        </button>
      </div>

      <div className="mt-4 rounded-2xl border border-white/10 bg-black/40 p-4">
        {err && <div className="text-xs text-red-400">{err}</div>}

        {!dataUrl ? (
          <div className="text-xs text-zinc-400">Generating QR…</div>
        ) : (
          <div className="flex items-center justify-center">
            <img
              src={dataUrl}
              alt="Wallet QR Code"
              className="h-56 w-56 rounded-xl border border-white/10 bg-black/30 p-2"
              draggable={false}
            />
          </div>
        )}

        <div className="mt-3 text-center font-mono text-xs text-zinc-400 break-all">
          {address}
        </div>
      </div>
    </div>
  );
}
