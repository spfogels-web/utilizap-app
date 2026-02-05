"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import QRCode from "qrcode";

type Props = {
  className?: string;
};

export default function ReceiveQr({ className = "" }: Props) {
  const { publicKey, connected } = useWallet();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const address = publicKey?.toBase58() ?? "";

  useEffect(() => {
    if (!connected || !address) {
      setDataUrl(null);
      return;
    }

    QRCode.toDataURL(address, {
      margin: 1,
      width: 220,
      color: { dark: "#000000", light: "#ffffff" },
    }).then(setDataUrl);
  }, [connected, address]);

  const onCopy = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  if (!connected) return null;

  return (
    <div className={`mt-4 rounded-xl border border-white/10 bg-black/40 p-4 ${className}`}>
      <div className="text-center space-y-1">
        <div className="text-sm font-semibold">Receive</div>
        <div className="text-xs text-zinc-400">Let someone scan to pay your wallet</div>
      </div>

      <div className="mt-3 flex justify-center">
        <button onClick={onCopy} className="uz-btn-secondary">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>

      {dataUrl && (
        <div className="mt-4 flex justify-center">
          <img
            src={dataUrl}
            alt="Wallet QR Code"
            className="h-56 w-56 rounded-xl border border-white/10 bg-white p-3"
            draggable={false}
          />
        </div>
      )}

      <div className="mt-3 text-center font-mono text-xs text-zinc-400 break-all">
        {address}
      </div>
    </div>
  );
}
