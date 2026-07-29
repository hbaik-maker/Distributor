const enc = new TextEncoder();

function base64urlEncode(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return Buffer.from(str, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
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

function getCookie(req, name) {
  const header = (req.headers && req.headers.cookie) || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/* Verifies the same signed session cookie middleware.js checks — API routes
 * are excluded from that Edge Middleware's matcher (they have to be, so
 * /api/verify itself is reachable pre-login), so every data-bearing API
 * route must independently re-check this before touching the database. */
async function requireSession(req, res) {
  const secret = process.env.SESSION_SECRET;
  const token = getCookie(req, "session");
  if (!secret || !token) {
    res.status(401).json({ ok: false, error: "Not signed in" });
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    res.status(401).json({ ok: false, error: "Not signed in" });
    return null;
  }
  const [payload, sig] = parts;
  const expected = await hmacSign(secret, payload);
  if (!timingSafeEqual(expected, sig)) {
    res.status(401).json({ ok: false, error: "Not signed in" });
    return null;
  }
  try {
    const json = JSON.parse(base64urlDecodeToBytes(payload).toString("utf8"));
    if (!json.exp || Date.now() > json.exp) {
      res.status(401).json({ ok: false, error: "Session expired" });
      return null;
    }
    if (!json.email || !json.email.toLowerCase().endsWith("@wooltariusa.com")) {
      res.status(401).json({ ok: false, error: "Not signed in" });
      return null;
    }
    return json;
  } catch {
    res.status(401).json({ ok: false, error: "Not signed in" });
    return null;
  }
}

module.exports = { requireSession };
