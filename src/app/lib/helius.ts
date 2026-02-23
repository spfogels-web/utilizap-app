// src/app/lib/helius.ts

type HeliusOpts = {
  limit?: number;
};

function getHeliusKey(): string {
  const k = process.env.NEXT_PUBLIC_HELIUS_API_KEY?.trim();
  if (!k) return "";
  return k;
}

export async function heliusAddressTransactions(
  address: string,
  opts: HeliusOpts = {}
): Promise<any[]> {
  const apiKey = getHeliusKey();
  if (!apiKey) {
    console.warn(
      "Missing NEXT_PUBLIC_HELIUS_API_KEY. Helius sync disabled."
    );
    return [];
  }

  const limit = typeof opts.limit === "number" ? opts.limit : 80;

  const url = new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
  url.searchParams.set("api-key", apiKey);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("Helius error:", res.status, text);
    return [];
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}