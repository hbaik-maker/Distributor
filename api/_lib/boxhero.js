// BoxHero REST API client — CommonJS port of the patterns proven in
// /home/hbaik/Hanktonomous/lib/boxhero.ts + lib/rate-limit.ts (same BoxHero
// account/token, shared rate budget).
//
// Confirmed directly against BoxHero's live OpenAPI spec
// (https://rest.boxhero-app.com/docs/spec):
// - POST/PUT transaction items accept `item_sku` directly — no separate
//   SKU -> item_id lookup call is needed before writing a move transaction.
// - DELETE /v1/transactions/{tx_id} requires a JSON request body (can be
//   empty) with optional `revision`/`memo` fields — unlike Hanktonomous's
//   version, which never needed to delete a transaction it didn't just create.

const BOXHERO_API_BASE = process.env.BOXHERO_API_BASE || "https://rest.boxhero-app.com";

function getBoxHeroToken() {
  const token = process.env.BOXHERO_API_TOKEN;
  if (!token) throw new Error("Missing required environment variable: BOXHERO_API_TOKEN");
  return token;
}

class BoxHeroApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "BoxHeroApiError";
    this.status = status;
    this.body = body;
  }
}

// Sliding-window rate limiter: at most `maxCalls` calls sharing `key` may
// *start* within any rolling `windowMs` window. Distributor shares its
// BoxHero token with Hanktonomous, so this is deliberately kept under that
// app's own 3/sec self-throttle even though the real per-token limit
// (confirmed live) is 300 requests/60s shared across every endpoint.
const BOXHERO_LIMIT = { maxCalls: 2, windowMs: 1000 };
const callStartTimes = new Map();
const queueTails = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimited(key, config, fn) {
  const previousTail = queueTails.get(key) || Promise.resolve();
  let releaseNext;
  const ourTail = new Promise((resolve) => { releaseNext = resolve; });
  queueTails.set(key, previousTail.then(() => ourTail));
  await previousTail;

  for (;;) {
    const now = Date.now();
    const starts = (callStartTimes.get(key) || []).filter((t) => now - t < config.windowMs);
    if (starts.length < config.maxCalls) {
      starts.push(now);
      callStartTimes.set(key, starts);
      break;
    }
    const wait = starts[0] + config.windowMs - now;
    await sleep(Math.max(wait, 10));
  }

  releaseNext();
  return fn();
}

const MAX_429_RETRIES = 3;

// BoxHero's rate limit is tied to the API token, not to this process, so an
// occasional 429 can slip through even when this client is behaving (e.g.
// Hanktonomous calling the same token concurrently). Retry using the
// `retryAfter` seconds BoxHero returns rather than failing the whole request.
async function boxheroFetch(path, init = {}, attempt = 1) {
  const method = init.method || "GET";
  const key = "boxhero";

  const res = await rateLimited(key, BOXHERO_LIMIT, () =>
    fetch(`${BOXHERO_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${getBoxHeroToken()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
    })
  );

  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { /* not all error responses are JSON */ }

    const retryAfterSeconds = body && typeof body === "object" && "retryAfter" in body
      ? Number(body.retryAfter)
      : Number(res.headers.get("retry-after"));

    if (res.status === 429 && attempt <= MAX_429_RETRIES && Number.isFinite(retryAfterSeconds)) {
      const waitMs = Math.max(retryAfterSeconds, 1) * 1000 + 200;
      await sleep(waitMs);
      return boxheroFetch(path, init, attempt + 1);
    }

    throw new BoxHeroApiError(`BoxHero API ${method} ${path} failed: ${res.status}`, res.status, body);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

let locationsCache = null;
let locationsInFlight = null;

// Locations never change during normal operation, so this fetches from
// BoxHero at most once per warm server instance.
async function listLocations() {
  if (locationsCache) return locationsCache;
  if (locationsInFlight) return locationsInFlight;
  locationsInFlight = boxheroFetch("/v1/locations").then(
    (data) => {
      locationsCache = data.items;
      locationsInFlight = null;
      return locationsCache;
    },
    (err) => {
      locationsInFlight = null;
      throw err;
    }
  );
  return locationsInFlight;
}

async function resolveLocationIdByName(name) {
  const locations = await listLocations();
  const match = locations.find((l) => l.name === name);
  if (!match) {
    throw new Error(
      `BoxHero location named "${name}" was not found. Checked ${locations.length} locations: ${locations.map((l) => l.name).join(", ")}`
    );
  }
  return match;
}

// GET /v1/transactions only filters by `type` (in/out/move/adjust) -- no
// date or location filter, and no per-item detail (confirmed against
// BoxHero's live /docs/spec: list items use the SimpleLocationTransaction*
// shapes, item lines only come back from GET /v1/transactions/{tx_id}).
// Ordered by id descending (newest first) per BoxHero's own docs.
async function listTransactionsPage({ type, cursor, limit } = {}) {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (cursor !== undefined && cursor !== null) params.set("cursor", cursor);
  if (limit) params.set("limit", limit);
  const qs = params.toString();
  return boxheroFetch(`/v1/transactions${qs ? `?${qs}` : ""}`);
}

// Sums per-SKU quantity for every `move` transaction from `fromLocationName`
// to `toLocationName` whose transaction_time falls in [sinceIso, untilIso).
// Pages backward from newest until transaction_time drops below sinceIso
// (safe because /v1/transactions is newest-first), then fetches full item
// detail only for the transactions that actually match the location pair --
// avoids a detail call per irrelevant move (e.g. EAST-side transfers).
async function sumMovedQuantitiesBetween({ fromLocationName, toLocationName, sinceIso, untilIso }) {
  const totals = new Map();
  let cursor;
  for (;;) {
    const page = await listTransactionsPage({ type: "move", cursor, limit: 100 });
    let hitFloor = false;
    for (const tx of page.items) {
      if (tx.transaction_time < sinceIso) { hitFloor = true; break; }
      if (tx.transaction_time >= untilIso) continue;
      if (tx.from_location.name !== fromLocationName || tx.to_location.name !== toLocationName) continue;
      const detail = await getTransactionDetail(tx.id);
      for (const line of detail.items) {
        totals.set(line.sku, (totals.get(line.sku) || 0) + line.quantity);
      }
    }
    if (hitFloor || !page.has_more) break;
    cursor = page.cursor;
  }
  return totals;
}

// items: [{ sku, quantity }] — up to 500 per call per BoxHero's spec; callers
// with more lines than that must chunk (see execute route).
async function createMoveTransaction({ fromLocationId, toLocationId, items, memo }) {
  const data = await boxheroFetch("/v1/transactions", {
    method: "POST",
    body: JSON.stringify({
      type: "move",
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      items: items.map((it) => ({ item_sku: it.sku, quantity: it.quantity })),
      memo: memo || "",
    }),
  });
  return data.id;
}

async function getTransactionDetail(txId) {
  const data = await boxheroFetch(`/v1/transactions/${txId}`);
  return data.item;
}

// PUT fully REPLACES the transaction's item list — confirmed live: omitting
// a line removes it cleanly, while a `quantity: 0` line is rejected with a
// 403 ("Quantity must be greater than zero"). Callers must never pass a
// zero-quantity line; filter those out first, and if nothing is left, use
// deleteTransaction instead of calling this at all.
async function updateMoveTransaction(txId, items, memo) {
  const detail = await getTransactionDetail(txId); // fresh revision, not a stored one — mirrors deleteTransaction's caller in rollback.js
  const data = await boxheroFetch(`/v1/transactions/${txId}`, {
    method: "PUT",
    body: JSON.stringify({
      items: items.map((it) => ({ item_sku: it.sku, quantity: it.quantity })),
      revision: detail.revision,
      ...(memo ? { memo } : {}),
    }),
  });
  return data.id;
}

// DELETE requires a JSON body (can be empty) per BoxHero's spec; `revision`
// is optional but enforces optimistic concurrency when supplied.
async function deleteTransaction(txId, revision, memo) {
  const body = {};
  if (revision !== undefined && revision !== null) body.revision = revision;
  if (memo) body.memo = memo;
  await boxheroFetch(`/v1/transactions/${txId}`, {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

module.exports = {
  BoxHeroApiError,
  listLocations,
  resolveLocationIdByName,
  createMoveTransaction,
  getTransactionDetail,
  updateMoveTransaction,
  deleteTransaction,
  sumMovedQuantitiesBetween,
};
