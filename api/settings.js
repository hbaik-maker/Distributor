const { requireSession } = require("./_lib/session");
const { query } = require("./_lib/db");

const COLS = [
  "cap_pct", "floor_pct", "target_days", "box_round_pct", "zero_box_round_pct", "no_box_min_ea", "no_box_hq_min_days",
  "kimchi_override_enabled", "kimchi_keyword", "kimchi_floor_pct", "kimchi_cap_pct",
  "kimchi_hard_cap_pct", "stale_sale_days_threshold", "storage_overrides_json",
];

const STORAGE_TYPES = ["냉동", "냉장", "상온"];
const STORAGE_OVERRIDABLE_KEYS = ["capPct", "floorPct", "targetDays", "boxRoundPct", "zeroBoxRoundPct", "noBoxMinEa", "noBoxHqMinDays"];

// Strips unknown storage types/keys and non-numeric values rather than
// hard-erroring — this API is only ever called from our own settings UI, and
// an invalid/partial override is easy to spot immediately in the review
// table's live-recomputed results, so no need for stricter cross-field
// (floor < cap) validation here on top of the base settings' own check below.
function sanitizeStorageOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const storageType of STORAGE_TYPES) {
    const ov = raw[storageType];
    if (!ov || typeof ov !== "object") continue;
    const cleaned = {};
    for (const key of STORAGE_OVERRIDABLE_KEYS) {
      if (ov[key] === null || ov[key] === undefined || ov[key] === "") continue;
      const num = Number(ov[key]);
      if (Number.isFinite(num)) cleaned[key] = num;
    }
    if (Object.keys(cleaned).length) out[storageType] = cleaned;
  }
  return out;
}

function rowToSettings(row) {
  return {
    capPct: row.cap_pct,
    floorPct: row.floor_pct,
    targetDays: row.target_days,
    boxRoundPct: row.box_round_pct,
    zeroBoxRoundPct: row.zero_box_round_pct,
    noBoxMinEa: row.no_box_min_ea,
    noBoxHqMinDays: row.no_box_hq_min_days,
    kimchiEnabled: row.kimchi_override_enabled,
    kimchiKeyword: row.kimchi_keyword,
    kimchiFloorPct: row.kimchi_floor_pct,
    kimchiCapPct: row.kimchi_cap_pct,
    kimchiHardCapPct: row.kimchi_hard_cap_pct,
    staleSaleDaysThreshold: row.stale_sale_days_threshold,
    storageOverrides: row.storage_overrides_json || {},
  };
}

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === "GET") {
    const { rows } = await query("SELECT * FROM distributor.settings ORDER BY id LIMIT 1");
    if (!rows.length) {
      res.status(404).json({ ok: false, error: "No settings row found" });
      return;
    }
    res.status(200).json({ ok: true, settings: rowToSettings(rows[0]) });
    return;
  }

  if (req.method === "PUT") {
    const s = req.body || {};
    const values = {
      cap_pct: s.capPct, floor_pct: s.floorPct, target_days: s.targetDays,
      box_round_pct: s.boxRoundPct, zero_box_round_pct: s.zeroBoxRoundPct, no_box_min_ea: s.noBoxMinEa,
      no_box_hq_min_days: s.noBoxHqMinDays,
      kimchi_override_enabled: !!s.kimchiEnabled, kimchi_keyword: s.kimchiKeyword || "김치",
      kimchi_floor_pct: s.kimchiFloorPct, kimchi_cap_pct: s.kimchiCapPct,
      kimchi_hard_cap_pct: s.kimchiHardCapPct, stale_sale_days_threshold: s.staleSaleDaysThreshold,
      storage_overrides_json: JSON.stringify(sanitizeStorageOverrides(s.storageOverrides)),
    };
    if (!(values.floor_pct > 0 && values.floor_pct < values.cap_pct && values.cap_pct <= 1) || !(values.target_days > 0)) {
      res.status(400).json({ ok: false, error: "Floor % must be less than Cap %, Cap % must be <= 100, and target days must be positive." });
      return;
    }
    if (!(values.zero_box_round_pct >= 0 && values.zero_box_round_pct <= values.box_round_pct)) {
      res.status(400).json({ ok: false, error: "Zero-box threshold % must be between 0 and the box rounding threshold %." });
      return;
    }
    if (!(values.no_box_min_ea >= 0)) {
      res.status(400).json({ ok: false, error: "Minimum EA for a loose pick must be 0 or more." });
      return;
    }
    if (!(values.no_box_hq_min_days >= 0)) {
      res.status(400).json({ ok: false, error: "Minimum HQ days for a loose pick must be 0 or more." });
      return;
    }
    if (!(values.stale_sale_days_threshold >= 1)) {
      res.status(400).json({ ok: false, error: "Stale sale threshold must be at least 1 day." });
      return;
    }
    if (!(values.kimchi_floor_pct >= 0 && values.kimchi_floor_pct < values.kimchi_cap_pct
        && values.kimchi_cap_pct < values.kimchi_hard_cap_pct && values.kimchi_hard_cap_pct <= 1)) {
      res.status(400).json({ ok: false, error: "Kimchi floor % must be less than cap %, which must be less than hard cap %, all <= 100." });
      return;
    }
    const setClause = COLS.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const params = COLS.map((c) => values[c]);
    await query(
      `UPDATE distributor.settings SET ${setClause} WHERE id = (SELECT id FROM distributor.settings ORDER BY id LIMIT 1)`,
      params
    );
    const { rows } = await query("SELECT * FROM distributor.settings ORDER BY id LIMIT 1");
    res.status(200).json({ ok: true, settings: rowToSettings(rows[0]) });
    return;
  }

  res.status(405).json({ ok: false, error: "Method not allowed" });
};
