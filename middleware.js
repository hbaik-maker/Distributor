export const config = {
  matcher: ["/((?!login.html|api/|favicon.ico).*)"],
};

const enc = new TextEncoder();

function base64urlEncode(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64urlEncode(new Uint8Array(sig));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySession(token, secret) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = await hmacSign(secret, payload);
  if (!timingSafeEqual(expected, sig)) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(base64urlDecodeToBytes(payload)));
    if (!json.exp || Date.now() > json.exp) return null;
    if (!json.email || !json.email.toLowerCase().endsWith("@wooltariusa.com")) return null;
    return json;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default async function middleware(request) {
  const secret = process.env.SESSION_SECRET;
  const token = getCookie(request, "session");
  const session = secret ? await verifySession(token, secret) : null;

  if (!session) {
    const loginUrl = new URL("/login.html", request.url);
    loginUrl.searchParams.set("next", new URL(request.url).pathname);
    return Response.redirect(loginUrl, 302);
  }
  // Valid session — let the request through to the static app.
}
