const enc = new TextEncoder();

function base64urlEncode(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return Buffer.from(str, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64urlEncode(new Uint8Array(sig));
}

async function signSession(payloadObj, secret) {
  const payload = base64urlEncode(enc.encode(JSON.stringify(payloadObj)));
  const sig = await hmacSign(secret, payload);
  return `${payload}.${sig}`;
}

const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours
const ALLOWED_DOMAIN = "wooltariusa.com";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!clientId || !sessionSecret) {
    res.status(500).json({ ok: false, error: "Server not configured" });
    return;
  }

  const credential = req.body && req.body.credential;
  if (!credential || typeof credential !== "string") {
    res.status(400).json({ ok: false, error: "Missing credential" });
    return;
  }

  let claims;
  try {
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!resp.ok) {
      res.status(401).json({ ok: false, error: "Invalid Google token" });
      return;
    }
    claims = await resp.json();
  } catch {
    res.status(502).json({ ok: false, error: "Could not verify token with Google" });
    return;
  }

  if (claims.aud !== clientId) {
    res.status(401).json({ ok: false, error: "Token was not issued for this app" });
    return;
  }
  if (claims.email_verified !== "true" && claims.email_verified !== true) {
    res.status(403).json({ ok: false, error: "Email not verified" });
    return;
  }
  const email = String(claims.email || "").toLowerCase();
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    res.status(403).json({ ok: false, error: `Access is restricted to @${ALLOWED_DOMAIN} accounts` });
    return;
  }

  const exp = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const session = await signSession({ email, exp }, sessionSecret);

  res.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(session)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`
  );
  res.status(200).json({ ok: true, email });
};
