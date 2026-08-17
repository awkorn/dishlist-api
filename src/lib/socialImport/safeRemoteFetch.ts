import dns from "dns/promises";
import net from "net";
import { SocialImportError } from "./types";

const MAX_REDIRECTS = 4;

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(normalized)) {
    if (normalized === "::" || normalized === "::1") return true;
    if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized)) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isPrivateAddress(mapped) : false;
  }
  return true;
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SocialImportError("SCRAPE_FAILED", "Unsupported remote protocol");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new SocialImportError("SCRAPE_FAILED", "Private remote host blocked");
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new SocialImportError("SCRAPE_FAILED", "Private remote address blocked");
  }
  return url;
}

export async function safeRemoteFetch(
  rawUrl: string,
  options: RequestInit & {
    maxBytes?: number;
    allowedMimePrefixes?: string[];
    maxRedirects?: number;
  } = {}
): Promise<Response> {
  let current = await assertPublicUrl(rawUrl);
  const { maxBytes, allowedMimePrefixes, maxRedirects = MAX_REDIRECTS, ...init } = options;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === maxRedirects) {
        throw new SocialImportError("SCRAPE_FAILED", "Unsafe or excessive redirect");
      }
      await response.body?.cancel().catch(() => {});
      current = await assertPublicUrl(new URL(location, current).toString());
      continue;
    }
    const length = Number(response.headers.get("content-length"));
    if (maxBytes && Number.isFinite(length) && length > maxBytes) {
      throw new SocialImportError("VIDEO_TOO_LONG", "Remote media exceeds size cap");
    }
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (
      response.ok &&
      allowedMimePrefixes?.length &&
      (!mime || !allowedMimePrefixes.some((prefix) => mime.startsWith(prefix)))
    ) {
      throw new SocialImportError("SCRAPE_FAILED", "Unexpected remote media type");
    }
    return response;
  }
  throw new SocialImportError("SCRAPE_FAILED", "Remote fetch failed");
}

export function withTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
