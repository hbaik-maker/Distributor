const { requireSession } = require("../../_lib/session");
const { query } = require("../../_lib/db");
const { resolveLocationIdByName, createMoveTransaction, getTransactionDetail } = require("../../_lib/boxhero");
const { computeShipmentStatus } = require("../../_lib/shipmentStatus");

// BoxHero caps a transaction's items array at 500 entries. Rather than
// silently splitting a leg across multiple untracked transactions (the
// schema stores exactly one boxhero_tx_id per leg), fail that leg clearly so
// a human can split the run instead — a leg this large is not the expected
// case for this app's real shipments.
const MAX_ITEMS_PER_TRANSACTION = 500;

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const shipmentId = parseInt(req.query.id, 10);
  if (!Number.isFinite(shipmentId)) {
    res.status(400).json({ ok: false, error: "Invalid shipment id" });
    return;
  }

  const { rows: shipmentRows } = await query("SELECT * FROM distributor.shipments WHERE id = $1", [shipmentId]);
  if (!shipmentRows.length) {
    res.status(404).json({ ok: false, error: "Shipment not found" });
    return;
  }
  const shipment = shipmentRows[0];

  // Every non-executed leg is attempted on each call — this is what makes
  // the endpoint double as "retry failed legs" and "re-execute after a
  // rollback" without a separate action. Excludes legs where scanning has
  // already started (in_progress or completed) — once a shipper has scanned
  // actuals, or reconciliation has zeroed the leg out via finalize-scan,
  // re-executing from the original planned_units would silently discard
  // that real-world data. Those legs must go through the scan flow, not this
  // one, to be corrected.
  const { rows: legRows } = await query(
    "SELECT * FROM distributor.shipment_legs WHERE shipment_id = $1 AND status != 'executed' AND scan_status = 'not_started' ORDER BY id",
    [shipmentId]
  );

  if (!legRows.length) {
    res.status(200).json({ ok: true, results: [], shipmentStatus: shipment.status });
    return;
  }

  let toLocationId;
  try {
    toLocationId = (await resolveLocationIdByName(shipment.staging_location_name)).id;
  } catch (e) {
    res.status(502).json({ ok: false, error: `Could not resolve staging location "${shipment.staging_location_name}" in BoxHero: ${e.message}` });
    return;
  }

  const results = [];
  for (const leg of legRows) {
    try {
      const { rows: itemRows } = await query(
        "SELECT sku, planned_units FROM distributor.shipment_leg_items WHERE shipment_leg_id = $1 ORDER BY sku",
        [leg.id]
      );
      if (itemRows.length > MAX_ITEMS_PER_TRANSACTION) {
        throw new Error(`Leg has ${itemRows.length} line items, over BoxHero's ${MAX_ITEMS_PER_TRANSACTION}-item-per-transaction limit — split this run.`);
      }
      const fromLocationId = (await resolveLocationIdByName(leg.source_location_name)).id;
      const items = itemRows.map((r) => ({ sku: r.sku, quantity: Number(r.planned_units) }));
      const memo = `Distributor run #${shipment.run_id} — ${leg.owner_group} — via Distributor`;

      const txId = await createMoveTransaction({ fromLocationId, toLocationId, items, memo });
      const detail = await getTransactionDetail(txId);

      await query(
        `UPDATE distributor.shipment_legs
         SET status = 'executed', boxhero_tx_id = $1, boxhero_tx_revision = $2, executed_at = now(), error_message = NULL
         WHERE id = $3`,
        [detail.id, detail.revision, leg.id]
      );
      results.push({ legId: leg.id, ok: true, boxheroTxId: detail.id });
    } catch (e) {
      await query(
        "UPDATE distributor.shipment_legs SET status = 'failed', error_message = $1 WHERE id = $2",
        [e.message, leg.id]
      );
      results.push({ legId: leg.id, ok: false, error: e.message });
    }
  }

  const { rows: allLegs } = await query("SELECT status FROM distributor.shipment_legs WHERE shipment_id = $1", [shipmentId]);
  const newStatus = computeShipmentStatus(allLegs.map((l) => l.status));
  await query("UPDATE distributor.shipments SET status = $1 WHERE id = $2", [newStatus, shipmentId]);

  res.status(200).json({ ok: true, results, shipmentStatus: newStatus });
};
