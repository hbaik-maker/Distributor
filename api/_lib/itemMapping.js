// Maps between the client's camelCase item objects (see ITEM_FIELDS /
// computeRecommendations in index.html) and distributor.run_items' snake_case
// columns. Keeping this in one place means the INSERT and SELECT sides can
// never drift out of sync with each other.
const FIELD_MAP = [
  ["sku", "sku"],
  ["barcode", "barcode"],
  ["name", "name"],
  ["englishName", "english_name"],
  ["category", "category"],
  ["statusOnline", "status_online"],
  ["importance", "importance"],
  ["storage", "storage"],
  ["hqOnline", "hq_online"],
  ["localTransOnline", "local_trans_online"],
  ["kpacOnline", "kpac_online"],
  ["hqQty", "hq_qty"],
  ["paArt", "pa_art"],
  ["paOnline", "pa_online"],
  ["eastOnhand", "east_onhand"],
  ["pa1Pre", "pa_1_pre"],
  ["pa2Pre", "pa_2_pre"],
  ["pa1AirPre", "pa_1_air_pre"],
  ["pa2AirPre", "pa_2_air_pre"],
  ["inTransit", "in_transit"],
  ["inTransitIgnored", "in_transit_ignored"],
  ["totalUnits", "total_units"],
  ["eastPosition", "east_position"],
  ["avg5", "avg5"],
  ["avg30", "avg30"],
  ["avg90", "avg90"],
  ["windowUsed", "window_used"],
  ["totalAvgDaily", "total_avg_daily"],
  ["eastAvgDaily", "east_avg_daily"],
  ["daysSinceLastSale", "days_since_last_sale"],
  ["desiredQty", "desired_qty"],
  ["minFloorQty", "min_floor_qty"],
  ["targetQty", "target_qty"],
  ["capRoom", "cap_room"],
  ["rawQty", "raw_qty"],
  ["bindingConstraint", "binding_constraint"],
  ["boxSize", "box_size"],
  ["cost", "cost"],
  ["csPerPlt", "cs_per_plt"],
  ["cbmEa", "cbm_ea"],
  ["roundingNote", "rounding_note"],
  ["finalQtyComputed", "final_qty_computed"],
  ["included", "included"],
  ["finalQtyUser", "final_qty_user"],
  ["grFew", "gr_few"],
  ["isKimchi", "is_kimchi"],
];

function itemToRow(runId, item) {
  const cols = ["run_id", "flags_json"];
  const vals = [runId, JSON.stringify(item.flags || [])];
  for (const [camel, snake] of FIELD_MAP) {
    cols.push(snake);
    vals.push(item[camel] === undefined ? null : item[camel]);
  }
  return { cols, vals };
}

function rowToItem(row) {
  const item = { flags: row.flags_json || [] };
  for (const [camel, snake] of FIELD_MAP) {
    item[camel] = row[snake];
  }
  return item;
}

// Postgres caps bound parameters at 65535 per query — batch inserts well
// under that so large runs (1900+ SKUs x ~40 columns) never hit the limit.
const BATCH_SIZE = 300;

async function insertItems(query, runId, items) {
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const batch = items.slice(start, start + BATCH_SIZE);
    const rows = batch.map((item) => itemToRow(runId, item));
    if (!rows.length) continue;
    const cols = rows[0].cols;
    const valueRows = [];
    const params = [];
    let p = 1;
    for (const row of rows) {
      const placeholders = row.vals.map(() => `$${p++}`);
      valueRows.push(`(${placeholders.join(",")})`);
      params.push(...row.vals);
    }
    await query(
      `INSERT INTO distributor.run_items (${cols.join(",")}) VALUES ${valueRows.join(",")}`,
      params
    );
  }
}

module.exports = { FIELD_MAP, itemToRow, rowToItem, insertItems };
