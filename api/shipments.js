const { requireSession } = require("./_lib/session");
const { query } = require("./_lib/db");

const VALID_HQ_LOCATIONS = ["00_HQ_Online", "10_LOCAL_TRANS_ONLINE"];
const VALID_STAGING_LOCATIONS = ["30_PA_1_PRE_STORAGE", "30_PA_2_PRE_STORAGE", "30_PA_2_AIR_PRE_STORAGE", "30_PA_1_AIR_PRE_STORAGE"];
const KPAC_LOCATION_NAME = "10_KPAC_Online";

function ownerGroupForStorage(storage) {
  return storage === "냉동" || storage === "냉장" ? "frozen_chilled" : "ambient";
}

// Mirrors kpacHqSplit in Wooltari_Distributor.html: KPAC is prioritized first
// (up to however many whole boxes of this SKU it actually holds), the rest of
// the box-level need falls back to HQ, and any leftover that doesn't make a
// full box is pulled as HQ units (never KPAC).
function kpacHqSplit(qty, boxSize, kpacOnline) {
  if (!boxSize) return { kpacBoxes: 0, hqBoxes: 0, hqUnits: qty };
  const boxesNeeded = Math.floor(qty / boxSize);
  const remainderUnits = qty - boxesNeeded * boxSize;
  const kpacAvailableBoxes = Math.floor((kpacOnline || 0) / boxSize);
  const kpacBoxes = Math.min(boxesNeeded, kpacAvailableBoxes);
  const hqBoxes = boxesNeeded - kpacBoxes;
  return { kpacBoxes, hqBoxes, hqUnits: remainderUnits };
}

// Cross-shipment queue of legs that have something physical left to scan —
// executed (a real BoxHero move exists) but not yet fully reconciled. Lives
// here (as GET /api/shipments) rather than its own file to stay under the
// Vercel Hobby plan's 12-serverless-function-per-deployment cap.
async function handleScanQueue(req, res) {
  const { rows } = await query(`
    SELECT sl.id AS leg_id, sl.shipment_id, sl.source_location_name, sl.owner_group, sl.scan_status, sl.owner,
           s.run_id, s.staging_location_name,
           (SELECT COUNT(*) FROM distributor.shipment_leg_items sli WHERE sli.shipment_leg_id = sl.id) AS item_count
    FROM distributor.shipment_legs sl
    JOIN distributor.shipments s ON s.id = sl.shipment_id
    WHERE sl.status = 'executed' AND sl.scan_status != 'completed'
    ORDER BY sl.id DESC
  `);

  res.status(200).json({
    ok: true,
    legs: rows.map((r) => ({
      legId: r.leg_id,
      shipmentId: r.shipment_id,
      runId: r.run_id,
      sourceLocationName: r.source_location_name,
      stagingLocationName: r.staging_location_name,
      ownerGroup: r.owner_group,
      scanStatus: r.scan_status,
      owner: r.owner,
      itemCount: Number(r.item_count),
    })),
  });
}

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === "GET") return handleScanQueue(req, res);

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const { runId, hqLocationName, stagingLocationName } = req.body || {};
  const parsedRunId = parseInt(runId, 10);
  if (!Number.isFinite(parsedRunId)) {
    res.status(400).json({ ok: false, error: "runId is required" });
    return;
  }
  if (!VALID_HQ_LOCATIONS.includes(hqLocationName)) {
    res.status(400).json({ ok: false, error: `hqLocationName must be one of: ${VALID_HQ_LOCATIONS.join(", ")}` });
    return;
  }
  if (!VALID_STAGING_LOCATIONS.includes(stagingLocationName)) {
    res.status(400).json({ ok: false, error: `stagingLocationName must be one of: ${VALID_STAGING_LOCATIONS.join(", ")}` });
    return;
  }

  const { rows: runRows } = await query("SELECT id, status FROM distributor.runs WHERE id = $1", [parsedRunId]);
  if (!runRows.length) {
    res.status(404).json({ ok: false, error: "Run not found" });
    return;
  }
  if (runRows[0].status !== "finalized") {
    res.status(400).json({ ok: false, error: "Run must be finalized before it can be shipped" });
    return;
  }

  const { rows: existing } = await query("SELECT id FROM distributor.shipments WHERE run_id = $1", [parsedRunId]);
  if (existing.length) {
    res.status(409).json({ ok: false, error: "A shipment has already been planned for this run", shipmentId: existing[0].id });
    return;
  }

  const { rows: items } = await query(
    `SELECT id, sku, storage, box_size, kpac_online, final_qty_user, final_qty_computed
     FROM distributor.run_items WHERE run_id = $1 AND included = true`,
    [parsedRunId]
  );

  // legKey (source location x owner group) -> accumulated line items
  const legs = new Map();
  function pushToLeg(sourceLocationName, ownerGroup, item) {
    const key = `${sourceLocationName}::${ownerGroup}`;
    if (!legs.has(key)) legs.set(key, { sourceLocationName, ownerGroup, items: [] });
    legs.get(key).items.push(item);
  }

  for (const it of items) {
    const qty = it.final_qty_user !== null && it.final_qty_user !== undefined
      ? Number(it.final_qty_user)
      : Number(it.final_qty_computed);
    if (!(qty > 0)) continue;
    const boxSize = it.box_size ? Number(it.box_size) : null;
    const ownerGroup = ownerGroupForStorage(it.storage);
    const { kpacBoxes, hqBoxes, hqUnits } = kpacHqSplit(qty, boxSize, Number(it.kpac_online) || 0);

    const kpacUnits = boxSize ? kpacBoxes * boxSize : 0;
    const hqUnitsTotal = boxSize ? hqBoxes * boxSize + hqUnits : qty;

    if (kpacUnits > 0) {
      pushToLeg(KPAC_LOCATION_NAME, ownerGroup, { runItemId: it.id, sku: it.sku, plannedBoxes: kpacBoxes, plannedUnits: kpacUnits });
    }
    if (hqUnitsTotal > 0) {
      pushToLeg(hqLocationName, ownerGroup, { runItemId: it.id, sku: it.sku, plannedBoxes: boxSize ? hqBoxes : null, plannedUnits: hqUnitsTotal });
    }
  }

  if (!legs.size) {
    res.status(400).json({ ok: false, error: "No included items with a positive ship quantity were found on this run" });
    return;
  }

  const { rows: shipmentRows } = await query(
    `INSERT INTO distributor.shipments (run_id, hq_location_name, staging_location_name, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [parsedRunId, hqLocationName, stagingLocationName, session.email]
  );
  const shipmentId = shipmentRows[0].id;

  for (const leg of legs.values()) {
    const { rows: legRows } = await query(
      `INSERT INTO distributor.shipment_legs (shipment_id, source_location_name, owner_group)
       VALUES ($1, $2, $3) RETURNING id`,
      [shipmentId, leg.sourceLocationName, leg.ownerGroup]
    );
    const legId = legRows[0].id;

    const valueRows = [];
    const params = [];
    let p = 1;
    for (const it of leg.items) {
      valueRows.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(legId, it.runItemId, it.sku, it.plannedBoxes, it.plannedUnits);
    }
    await query(
      `INSERT INTO distributor.shipment_leg_items (shipment_leg_id, run_item_id, sku, planned_boxes, planned_units)
       VALUES ${valueRows.join(",")}`,
      params
    );
  }

  res.status(200).json({ ok: true, id: shipmentId });
};
