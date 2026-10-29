// HTTP Basic authentication for the hosted dashboards. Runtime-agnostic on purpose: only
// atob, TextEncoder and TextDecoder, so the same code runs in the Vercel middleware, in the
// local dev server and in the tests.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: false});

// "Basic <base64(user:password)>" -> {user, password}; null for anything else. The password
// may contain colons: only the first colon separates the two parts.
export function parseBasicAuthorization(header) {
  if (typeof header !== 'string') return null;
  const match = header.match(/^\s*Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i);
  if (!match) return null;
  let binary;
  try { binary = atob(match[1].replace(/-/g, '+').replace(/_/g, '/')); } catch (_) { return null; }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const text = decoder.decode(bytes);
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  return {user: text.slice(0, colon), password: text.slice(colon + 1)};
}

// Constant-time comparison over the UTF-8 bytes of both strings. The loop always runs over the
// longer length so the time does not depend on where the first difference is.
export function timingSafeEqualStrings(a, b) {
  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

// {status: 'unconfigured' | 'denied' | 'ok'}. Unconfigured (an empty user or password) must
// be treated as "deny everything" by callers: a dashboard without a sign-in is never open.
export function authorize(header, {user, password} = {}) {
  if (!user || !password) return {status: 'unconfigured'};
  const presented = parseBasicAuthorization(header);
  if (!presented) return {status: 'denied'};
  const userOk = timingSafeEqualStrings(presented.user, user);
  const passwordOk = timingSafeEqualStrings(presented.password, password);
  return {status: userOk && passwordOk ? 'ok' : 'denied'};
}
