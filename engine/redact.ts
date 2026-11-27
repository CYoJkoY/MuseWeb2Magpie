// Log lines and error bodies end up in bug reports, so every path that writes one goes through
// here. The three shapes below are the ones that carry a credential: an Authorization header, a
// token in a query string, and a muse.ai cookie pair.

export function redact(text: unknown): string {
  return String(text ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/([?&](?:key|token|access_token|refresh_token|api_key)=)[^&\s]+/gi, "$1***")
    .replace(/\b(hatch_[a-z_]+)=([^;\s]+)/gi, "$1=***")
}
