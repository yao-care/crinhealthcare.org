/**
 * Prefix an internal path with the base URL.
 * Works with any base setting including '/'.
 */
export function url(path: string): string {
  const base = import.meta.env.BASE_URL;
  // Remove leading slash from path to avoid double slash
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  // Ensure base ends with /
  const cleanBase = base.endsWith('/') ? base : base + '/';
  return cleanBase + cleanPath;
}
