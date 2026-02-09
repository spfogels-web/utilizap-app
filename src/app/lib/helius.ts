// src/app/lib/helius.ts

export type HeliusTx = {
  signature: string;

  // Enhanced API commonly returns `timestamp` (seconds)
  timestamp?: number;

  // sometimes present
  blockTime?: number;

  // Enhanced API error field
  transactionError?: any;

  description?: string;
  type?: string;
  source?: string;

  tokenTransfers?: any[];
  nativeTransfers?: any[];
  accountData?: any[];
  events?: any;

  // Some variants might include rpc-like err
  err?: any;
};

export type HeliusAddressTxOpts = {
  limit?: number;
  before?: string;
  until?: string;
};

function cluster(): "devnet" | "mainnet-beta" {
  const c = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet").toLowerCase();
  return c === "mainnet" || c === "mainnet-beta" ? "mainnet-beta" : "devnet";
}

function heliusEnhancedBase(): string {
  return cluster() === "mainnet-beta"
    ? "https://api.helius-rpc.com"
    : "https://api-devnet.helius-rpc.com";
}

function heliusKey(): string {
  const key = process.env.NEXT_PUBLIC_HELIUS_API_KEY;
  if (!key) throw new Error("Missing NEXT_PUBLIC_HELIUS_API_KEY");
  return key;
}

/**
 * Enhanced API: Parsed transaction history for an address.
 * GET /v0/addresses/{address}/transactions?api-key=...&limit=...
 */
export async function heliusAddressTransactions(
  address: string,
  opts: HeliusAddressTxOpts = {}
): Promise<HeliusTx[]> {
  const base = heliusEnhancedBase();
  const key = heliusKey();

  const params = new URLSearchParams();
  params.set("api-key", key);
  params.set("limit", String(opts.limit ?? 50));
  if (opts.before) params.set("before", opts.before);
  if (opts.until) params.set("until", opts.until);

  const url = `${base}/v0/addresses/${address}/transactions?${params.toString()}`;

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Helius Enhanced API error ${res.status}: ${text || res.statusText}`
    );
  }

  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? (data as HeliusTx[]) : [];
}

/**
 * Optional JSON-RPC helper (separate from Enhanced API)
 */
export async function heliusRpc<T = any>(
  method: string,
  params: any[] = []
): Promise<T> {
  const key = heliusKey();

  const rpcUrl =
    cluster() === "mainnet-beta"
      ? `https://mainnet.helius-rpc.com/?api-key=${key}`
      : `https://devnet.helius-rpc.com/?api-key=${key}`;

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Helius RPC error ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json().catch(() => null);
  if (!json) throw new Error("Helius RPC: invalid JSON response");
  if (json?.error) throw new Error(`Helius RPC error: ${JSON.stringify(json.error)}`);
  return json.result as T;
}
