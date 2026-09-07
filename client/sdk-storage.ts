/** Colyseus' optional auth storage must not prevent account-free room joins. */
const fallback = new Map<string, string>();
export function getItem(key: string, callback: (value: string | null) => void): void {
  let value = fallback.get(key) ?? null;
  try { value = localStorage.getItem(key) ?? value; } catch { /* Browser storage is optional. */ }
  callback(value);
}
export function setItem(key: string, value: string): void {
  fallback.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* Retain the session copy. */ }
}
export function removeItem(key: string): void {
  fallback.delete(key);
  try { localStorage.removeItem(key); } catch { /* Session copy is already cleared. */ }
}
