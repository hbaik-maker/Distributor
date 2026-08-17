// Tari (WMS) public REST API client — GET-only, keyset-paginated.
// Spec: /home/hbaik/Distributor/Tari/api-1.json
// Replaces the weekly "Wooltari Datasource.xlsx" upload as the source for
// the boxhero/scm_sales sheets computeRecommendations expects. Builds rows
// keyed by the exact same column-name strings those sheets used, so
// computeRecommendations (client-side, Wooltari_Distributor.html) needs no
// changes at all.

const TARI_API_BASE = "https://tari.wooltariusa.com/api/public";

function getTariToken() {
  const token = process.env.TARI_API_TOKEN;
  if (!token) throw new Error("Missing required environment variable: TARI_API_TOKEN");
  return token;
}

class TariApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "TariApiError";
    this.status = status;
    this.body = body;
  }
}

// Tari allows 5 calls/sec (burst) AND 100 calls/min (sustained) per token.
// Satisfy both sliding windows before letting a call start. Real volume here
// is only ~10 requests per full sync, so this never actually throttles in
// practice — it's a correctness/future-proofing measure, same spirit as
// boxhero.js's BOXHERO_LIMIT.
const TARI_LIMITS = [
  { maxCalls: 5, windowMs: 1000 },
  { maxCalls: 100, windowMs: 60_000 },
];
const callStartTimes = new Map();
let queueTail = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimited(fn) {
  const previousTail = queueTail;
  let releaseNext;
  const ourTail = new Promise((resolve) => { releaseNext = resolve; });
  queueTail = previousTail.then(() => ourTail);
  await previousTail;

  for (;;) {
    const now = Date.now();
    let waitMs = 0;
    for (const config of TARI_LIMITS) {
      const key = `${config.maxCalls}/${config.windowMs}`;
      const starts = (callStartTimes.get(key) || []).filter((t) => now - t < config.windowMs);
      callStartTimes.set(key, starts);
      if (starts.length >= config.maxCalls) {
        waitMs = Math.max(waitMs, starts[0] + config.windowMs - now);
      }
    }
    if (waitMs <= 0) {
      for (const config of TARI_LIMITS) {
        const key = `${config.maxCalls}/${config.windowMs}`;
        callStartTimes.get(key).push(now);
      }
      break;
    }
    await sleep(Math.max(waitMs, 10));
  }

  releaseNext();
  return fn();
}

const MAX_429_RETRIES = 3;

// Tari doesn't document a retry-after header/field (confirmed: a live 429
// response carried no retry-after header), unlike BoxHero — so back off a
// fixed interval rather than reading one. Our own rate limiter already
// keeps this app under the documented limits; a 429 here means some other
// concurrent usage of this token pushed over, so a short fixed wait and
// retry is enough.
async function tariFetch(path, params = {}, attempt = 1) {
  const url = new URL(`${TARI_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const res = await rateLimited(() =>
    fetch(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${getTariToken()}` },
      cache: "no-store",
    })
  );

  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { /* not all error responses are JSON */ }
    if (res.status === 429 && attempt <= MAX_429_RETRIES) {
      await sleep(1000 * attempt);
      return tariFetch(path, params, attempt + 1);
    }
    throw new TariApiError(`Tari API GET ${path} failed: ${res.status}`, res.status, body);
  }
  return res.json();
}

async function fetchAllPages(path) {
  let cursor;
  const rows = [];
  for (;;) {
    const page = await tariFetch(path, { limit: 500, cursor });
    rows.push(...page.data);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return rows;
}

const STORAGE_CONDITION_KO = { frozen: "냉동", refrigerated: "냉장", ambient: "상온" };

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// items.case_volume_m3 / units_per_case when both present; otherwise leave
// CBM(EA) blank and pass through the raw dimension columns so the existing
// resolveCbmEa fallback chain in Wooltari_Distributor.html (unit dims ->
// CBM(CTN)/boxSize -> carton dims/boxSize -> nominal default) still works.
function resolveCbmEaFromItem(item) {
  if (item && num(item.case_volume_m3) > 0 && num(item.units_per_case) > 0) {
    return item.case_volume_m3 / item.units_per_case;
  }
  return null;
}

function buildBoxheroRow(legacy, item) {
  const storageRaw = (legacy && legacy.storage_condition) || (item && item.storage_condition) || null;
  const cbmEa = resolveCbmEaFromItem(item);
  return {
    SKU: legacy.sku,
    Barcode: legacy.barcode,
    Name: legacy.name,
    "English Name": legacy.name_en,
    Category: (item && item.category_name) || "",
    "입수/박스": (item && num(item.units_per_case) > 0) ? item.units_per_case : num(legacy.units_per_case),
    "Status.Online": (legacy.sales_status_online || (item && item.status) || ""),
    // md_grade is a manually-curated field, not derived from actual sales
    // data -- deliberately not used. sales_grade is the auto-computed grade,
    // so it's the only one that feeds 온라인 중요도.
    "온라인 중요도": (item && item.sales_grade) || "",
    "보관": STORAGE_CONDITION_KO[storageRaw] || "",
    "Qty(00_HQ_Online)": num(legacy.stock_hq_west_online),
    "Qty(10_LOCAL_TRANS_ONLINE)": num(legacy.stock_lc_west_online),
    // B2B stock (stock_*_b2b) is deliberately excluded everywhere in this
    // mapping -- it's committed/reserved for wholesale customers, not
    // available to ship to EAST for online demand.
    "Qty(10_KPAC_Online)": num(legacy.stock_kpac_west_online),
    // Folded into Qty(10_PA_ONLINE) below — Tari has no separate ART field
    // anywhere (legacy-stocks or WMS-native inventory); confirmed via
    // correlation that stock_main_east_online already includes it.
    "Qty(10_PA_ART)": 0,
    "Qty(10_PA_ONLINE)": num(legacy.stock_main_east_online),
    // Tari exposes one combined staging bucket (stock_ltl_east_temp), not a
    // per-sub-location breakdown. Functionally equivalent to today's
    // max(4 buckets) under the established mutual-exclusivity assumption.
    "Qty(30_PA_1_PRE_STORAGE)": num(legacy.stock_ltl_east_temp),
    "Qty(30_PA_2_PRE_STORAGE)": 0,
    "Qty(30_PA_1_AIR_PRE_STORAGE)": 0,
    "Qty(30_PA_2_AIR_PRE_STORAGE)": 0,
    Cost: (item && num(item.landed_cost) > 0) ? item.landed_cost : 0,
    "CS/PLT": (item && num(item.cases_per_pallet) > 0) ? item.cases_per_pallet : 0,
    "CBM(EA)": cbmEa,
    "unit_length_mm": item ? item.unit_length_mm : null,
    "unit_width_mm": item ? item.unit_width_mm : null,
    "unit_height_mm": item ? item.unit_height_mm : null,
    "카툰사이즈 mm (가로)": item ? item.case_length_mm : null,
    "카툰사이즈 mm (세로)": item ? item.case_width_mm : null,
    "카툰사이즈 mm (높이)": item ? item.case_height_mm : null,
  };
}

// Raw-count formula validated against 1,301 overlapping SKUs (this
// session): correlates ~0.80-0.81 with the old scm_sales-based estimate,
// and stays closer to its historical scale than Tari's own adj_daily
// fields. No 90-day window exists in Tari, so those fields are always 0 —
// the existing max-of-{5d,30d,90d} picker in computeRecommendations simply
// never selects 90d as a result. Retail sales are treated as 100% West:
// all of Wooltari's physical stores (LA, La Mirada, Seattle) are West-coast
// and Tari has no East retail channel at all.
function buildScmRow(legacy) {
  const on5 = num(legacy.online_sold_5d), on30 = num(legacy.online_sold_30d);
  const re5 = num(legacy.retail_sold_5d), re30 = num(legacy.retail_sold_30d);
  const onE5 = num(legacy.online_sold_east_5d), onE30 = num(legacy.online_sold_east_30d);
  const sold30Total = on30 + re30;
  return {
    sku: legacy.sku,
    "5d_avg_daily_qty": (on5 + re5) / 5,
    "30d_avg_daily_qty": sold30Total / 30,
    "90d_avg_daily_qty": 0,
    "5d_east_qty": onE5,
    "5d_west_qty": (on5 - onE5) + re5,
    "30d_east_qty": onE30,
    "30d_west_qty": (on30 - onE30) + re30,
    "90d_east_qty": 0,
    "90d_west_qty": 0,
    last_sale_date: sold30Total > 0 ? legacy.refreshed_at : null,
    refreshed_at: legacy.refreshed_at,
  };
}

async function buildDatasource() {
  const [legacyStocks, items] = await Promise.all([
    fetchAllPages("/legacy-stocks"),
    fetchAllPages("/items"),
  ]);
  const itemsBySku = new Map();
  for (const it of items) {
    if (it.sku) itemsBySku.set(String(it.sku).trim(), it);
  }

  const boxhero = [];
  const scm = [];
  let fetchedAt = null;
  for (const legacy of legacyStocks) {
    if (!legacy.sku) continue;
    const item = itemsBySku.get(String(legacy.sku).trim()) || null;
    boxhero.push(buildBoxheroRow(legacy, item));
    scm.push(buildScmRow(legacy));
    if (legacy.refreshed_at && (!fetchedAt || legacy.refreshed_at > fetchedAt)) fetchedAt = legacy.refreshed_at;
  }

  return { boxhero, scm, fetchedAt };
}

module.exports = {
  TariApiError,
  fetchAllPages,
  buildDatasource,
};
