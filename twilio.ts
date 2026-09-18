// Twilio request signing and TwiML replies, using Web Crypto so it runs on Workers.

/**
 * Twilio signs each webhook with HMAC-SHA1 over the full URL followed by every
 * POST parameter, sorted by key, concatenated as key+value with no separators.
 * The URL must match exactly what Twilio called — that is why PUBLIC_URL is
 * configured rather than read from the request.
 */
export async function verifySignature(
  authToken: string,
  signature: string,
  url: string,
  params: URLSearchParams,
): Promise<boolean> {
  if (!signature) return false;

  const keys = [...params.keys()].sort();
  let payload = url;
  for (const key of keys) payload += key + params.get(key);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_REPLY_CHARS = 1400;

/** Wrap a reply as TwiML. Long lists are truncated so one message can't cost 12 segments. */
export function twiml(body: string): Response {
  let text = body;
  if (text.length > MAX_REPLY_CHARS) {
    text = text.slice(0, MAX_REPLY_CHARS - 40).trimEnd() + '\n… (list too long to text in full)';
  }
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Message>${escapeXml(text)}</Message></Response>`;

  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

/** An empty 200 — Twilio sends nothing back to the sender. */
export function silence(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
