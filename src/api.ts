let tokenProvider: (() => Promise<string | null>) | undefined;

export const setTokenProvider = (provider: () => Promise<string | null>) => { tokenProvider = provider; };

export async function callFunction<T>(name: string, data: Record<string, unknown> = {}): Promise<T> {
  const token = await tokenProvider?.();
  if (!token) throw new Error("Sign in to continue.");
  const base = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  const response = await fetch(`${base}/api/actions/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  window.dispatchEvent(new Event("howmuchah:refresh"));
  return result as T;
}

export async function getBootstrap<T>(): Promise<T> {
  const token = await tokenProvider?.();
  if (!token) throw new Error("Sign in to continue.");
  const base = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  const response = await fetch(`${base}/api/bootstrap`, { headers: { Authorization: `Bearer ${token}` } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result as T;
}
