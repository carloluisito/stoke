export async function api(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export const usd = (n) => `$${(n ?? 0).toFixed(n >= 10 ? 0 : 2)}`;
export const tok = (n) => (n ?? 0) >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : (n ?? 0) >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n ?? 0}`;
