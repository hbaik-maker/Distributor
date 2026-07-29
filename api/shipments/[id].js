const { requireSession } = require("../_lib/session");
const { query } = require("../_lib/db");

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const runId = parseInt(req.query.id, 10);
  if (!Number.isFinite(runId)) {
    res.status(400).json({ ok: false, error: "Invalid run id" });
    return;
  }

  const { rows: shipmentRows } = await query("SELECT * FROM distributor.shipments WHERE run_id = $1", [runId]);
  if (!shipmentRows.length) {
    res.status(200).json({ ok: true, shipment: null });
    return;
  }
  const shipment = shipmentRows[0];

  const { rows: legRows } = await query(
    "SELECT * FROM distributor.shipment_legs WHERE shipment_id = $1 ORDER BY id",
    [shipment.id]
  );
  const { rows: itemRows } = await query(
    `SELECT sli.* FROM distributor.shipment_leg_items sli
     JOIN distributor.shipment_legs sl ON sl.id = sli.shipment_leg_id
     WHERE sl.shipment_id = $1 ORDER BY sli.shipment_leg_id, sli.sku`,
    [shipment.id]
  );

  const itemsByLeg = new Map();
  for (const row of itemRows) {
    if (!itemsByLeg.has(row.shipment_leg_id)) itemsByLeg.set(row.shipment_leg_id, []);
    itemsByLeg.get(row.shipment_leg_id).push({
      sku: row.sku,
      plannedBoxes: row.planned_boxes === null ? null : Number(row.planned_boxes),
      plannedUnits: Number(row.planned_units),
    });
  }

  const legs = legRows.map((leg) => ({
    id: leg.id,
    sourceLocationName: leg.source_location_name,
    ownerGroup: leg.owner_group,
    owner: leg.owner,
    status: leg.status,
    scanStatus: leg.scan_status,
    boxheroTxId: leg.boxhero_tx_id,
    boxheroTxRevision: leg.boxhero_tx_revision,
    executedAt: leg.executed_at,
    errorMessage: leg.error_message,
    items: itemsByLeg.get(leg.id) || [],
  }));

  res.status(200).json({
    ok: true,
    shipment: {
      id: shipment.id,
      runId: shipment.run_id,
      status: shipment.status,
      hqLocationName: shipment.hq_location_name,
      stagingLocationName: shipment.staging_location_name,
      createdBy: shipment.created_by,
      createdAt: shipment.created_at,
      legs,
    },
  });
};
