// Consolidates rollback/scan/scan-item/finalize-scan into one function file
// (dispatched on the `action` path segment) — the Vercel Hobby plan caps a
// deployment at 12 serverless functions, and this app already needed more
// than that once Phase 2 added its own leg-scoped routes.
const { requireSession } = require("../../../_lib/session");
const { query } = require("../../../_lib/db");
const { getTransactionDetail, deleteTransaction, updateMoveTransaction } = require("../../../_lib/boxhero");
const { computeShipmentStatus } = require("../../../_lib/shipmentStatus");

async function handleRollback(req, res, legId) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const { rows } = await query("SELECT * FROM distributor.shipment_legs WHERE id = $1", [legId]);
  if (!rows.length) {
    res.status(404).json({ ok: false, error: "Leg not found" });
    return;
  }
  const leg = rows[0];
  if (leg.status !== "executed") {
    res.status(400).json({ ok: false, error: `Only executed legs can be rolled back (current status: ${leg.status})` });
    return;
  }
  if (leg.scan_status !== "not_started") {
    res.status(400).json({ ok: false, error: "Cannot roll back — scanning has already started for this leg. Re-executing after a rollback would overwrite BoxHero with the original planned quantities, discarding everything scanned." });
    return;
  }
  if (!leg.boxhero_tx_id) {
    res.status(400).json({ ok: false, error: "This leg has no BoxHero transaction recorded" });
    return;
  }

  try {
    // Re-fetch fresh rather than trusting the stored revision — something
    // else may have touched this transaction in BoxHero since we executed it.
    const detail = await getTransactionDetail(leg.boxhero_tx_id);
    await deleteTransaction(detail.id, detail.revision, `Rolled back via Distributor (leg #${legId})`);
    await query(
      "UPDATE distributor.shipment_legs SET status = 'rolled_back', error_message = NULL WHERE id = $1",
      [legId]
    );
  } catch (e) {
    res.status(502).json({ ok: false, error: `Rollback failed: ${e.message}` });
    return;
  }

  const { rows: allLegs } = await query("SELECT status FROM distributor.shipment_legs WHERE shipment_id = $1", [leg.shipment_id]);
  const newStatus = computeShipmentStatus(allLegs.map((l) => l.status));
  await query("UPDATE distributor.shipments SET status = $1 WHERE id = $2", [newStatus, leg.shipment_id]);

  res.status(200).json({ ok: true });
}

async function handleScan(req, res, legId) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const { rows: legRows } = await query(
    `SELECT sl.*, s.staging_location_name, s.run_id
     FROM distributor.shipment_legs sl
     JOIN distributor.shipments s ON s.id = sl.shipment_id
     WHERE sl.id = $1`,
    [legId]
  );
  if (!legRows.length) {
    res.status(404).json({ ok: false, error: "Leg not found" });
    return;
  }
  const leg = legRows[0];

  const { rows: itemRows } = await query(
    `SELECT sli.sku, sli.planned_boxes, sli.planned_units, sli.actual_boxes, sli.actual_loose_units,
            sli.actual_units, sli.pallet_no, sli.scanned_at, sli.scanned_by,
            ri.barcode, ri.name, ri.english_name, ri.box_size
     FROM distributor.shipment_leg_items sli
     JOIN distributor.run_items ri ON ri.id = sli.run_item_id
     WHERE sli.shipment_leg_id = $1
     ORDER BY sli.sku`,
    [legId]
  );

  // Same shipment's other legs — used client-side to give a helpful "this
  // item belongs to the other leg" message on a scan miss.
  const { rows: siblingRows } = await query(
    `SELECT sl2.id AS leg_id, sl2.source_location_name, sl2.owner_group, sli2.sku, ri2.barcode
     FROM distributor.shipment_legs sl2
     JOIN distributor.shipment_leg_items sli2 ON sli2.shipment_leg_id = sl2.id
     JOIN distributor.run_items ri2 ON ri2.id = sli2.run_item_id
     WHERE sl2.shipment_id = $1 AND sl2.id != $2`,
    [leg.shipment_id, legId]
  );

  res.status(200).json({
    ok: true,
    leg: {
      id: leg.id,
      shipmentId: leg.shipment_id,
      runId: leg.run_id,
      sourceLocationName: leg.source_location_name,
      stagingLocationName: leg.staging_location_name,
      ownerGroup: leg.owner_group,
      owner: leg.owner,
      status: leg.status,
      scanStatus: leg.scan_status,
      boxheroTxId: leg.boxhero_tx_id,
    },
    items: itemRows.map((r) => ({
      sku: r.sku,
      barcode: r.barcode,
      name: r.name,
      englishName: r.english_name,
      boxSize: r.box_size === null ? null : Number(r.box_size),
      plannedBoxes: r.planned_boxes === null ? null : Number(r.planned_boxes),
      plannedUnits: Number(r.planned_units),
      actualBoxes: r.actual_boxes === null ? null : Number(r.actual_boxes),
      actualLooseUnits: r.actual_loose_units === null ? null : Number(r.actual_loose_units),
      actualUnits: r.actual_units === null ? null : Number(r.actual_units),
      palletNo: r.pallet_no,
      scannedAt: r.scanned_at,
      scannedBy: r.scanned_by,
    })),
    siblingLegs: siblingRows.map((r) => ({
      legId: r.leg_id,
      sourceLocationName: r.source_location_name,
      ownerGroup: r.owner_group,
      sku: r.sku,
      barcode: r.barcode,
    })),
  });
}

async function handleScanItem(req, res, legId, session) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const { sku, actualBoxes, actualLooseUnits, palletNo } = req.body || {};
  if (!sku) {
    res.status(400).json({ ok: false, error: "sku is required" });
    return;
  }

  const { rows: legRows } = await query("SELECT id, status FROM distributor.shipment_legs WHERE id = $1", [legId]);
  if (!legRows.length) {
    res.status(404).json({ ok: false, error: "Leg not found" });
    return;
  }
  if (legRows[0].status !== "executed") {
    res.status(400).json({ ok: false, error: `Can only scan items on an executed leg (current status: ${legRows[0].status})` });
    return;
  }

  const { rows: itemRows } = await query(
    `SELECT sli.id, ri.box_size FROM distributor.shipment_leg_items sli
     JOIN distributor.run_items ri ON ri.id = sli.run_item_id
     WHERE sli.shipment_leg_id = $1 AND sli.sku = $2`,
    [legId, sku]
  );
  if (!itemRows.length) {
    res.status(404).json({ ok: false, error: `SKU ${sku} is not part of this leg` });
    return;
  }
  const boxSize = itemRows[0].box_size ? Number(itemRows[0].box_size) : null;

  const boxes = boxSize ? (Number(actualBoxes) || 0) : null;
  const looseUnits = Number(actualLooseUnits) || 0;
  const units = boxSize ? boxes * boxSize + looseUnits : looseUnits;

  if (!(units >= 0)) {
    res.status(400).json({ ok: false, error: "Actual quantity must be 0 or more" });
    return;
  }

  await query(
    `UPDATE distributor.shipment_leg_items
     SET actual_boxes = $1, actual_loose_units = $2, actual_units = $3, pallet_no = $4,
         scanned_at = now(), scanned_by = $5
     WHERE id = $6`,
    [boxes, looseUnits, units, palletNo || null, session.email, itemRows[0].id]
  );

  // Every write reopens scan_status (even from 'completed') and reassigns
  // owner to whoever most recently scanned — editing a line after finalizing
  // naturally flips the leg back to "needs re-finalize" rather than silently
  // drifting from what's live in BoxHero.
  await query(
    "UPDATE distributor.shipment_legs SET scan_status = 'in_progress', owner = $1 WHERE id = $2",
    [session.email, legId]
  );

  res.status(200).json({ ok: true, actualUnits: units });
}

async function handleFinalizeScan(req, res, legId, session) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const { rows: legRows } = await query("SELECT * FROM distributor.shipment_legs WHERE id = $1", [legId]);
  if (!legRows.length) {
    res.status(404).json({ ok: false, error: "Leg not found" });
    return;
  }
  const leg = legRows[0];
  if (leg.status !== "executed") {
    res.status(400).json({ ok: false, error: `Can only finalize an executed leg (current status: ${leg.status})` });
    return;
  }

  const { rows: itemRows } = await query(
    "SELECT sku, planned_units, actual_units, scanned_at FROM distributor.shipment_leg_items WHERE shipment_leg_id = $1 ORDER BY sku",
    [legId]
  );

  const unscanned = itemRows.filter((r) => !r.scanned_at);
  if (unscanned.length) {
    res.status(400).json({ ok: false, error: `Not all items have been scanned yet: ${unscanned.map((r) => r.sku).join(", ")}` });
    return;
  }

  const anyDiff = itemRows.some((r) => Number(r.actual_units) !== Number(r.planned_units));
  let action = "no_difference";

  try {
    if (anyDiff) {
      const nonZeroItems = itemRows
        .filter((r) => Number(r.actual_units) > 0)
        .map((r) => ({ sku: r.sku, quantity: Number(r.actual_units) }));
      const memo = `Actuals from scan — leg #${legId} — by ${session.email}`;

      if (!nonZeroItems.length) {
        // Every item scanned to zero — nothing was really shipped on this
        // leg. Delete the transaction rather than PUT an empty items array
        // (BoxHero requires at least one line). 'rolled_back' is the
        // closest existing status — execute.js's retry query (status !=
        // 'executed' AND scan_status = 'not_started') won't accidentally
        // recreate this from the original planned_units, since scan_status
        // is about to become 'completed' below.
        const detail = await getTransactionDetail(leg.boxhero_tx_id);
        await deleteTransaction(detail.id, detail.revision, memo);
        await query(
          "UPDATE distributor.shipment_legs SET status = 'rolled_back', boxhero_tx_id = NULL, boxhero_tx_revision = NULL WHERE id = $1",
          [legId]
        );
        action = "deleted";
      } else {
        const txId = await updateMoveTransaction(leg.boxhero_tx_id, nonZeroItems, memo);
        const detail = await getTransactionDetail(txId);
        await query(
          "UPDATE distributor.shipment_legs SET boxhero_tx_revision = $1 WHERE id = $2",
          [detail.revision, legId]
        );
        action = "updated";
      }
    }

    await query("UPDATE distributor.shipment_legs SET scan_status = 'completed' WHERE id = $1", [legId]);
  } catch (e) {
    res.status(502).json({ ok: false, error: `Finalize failed: ${e.message}` });
    return;
  }

  const { rows: allLegs } = await query("SELECT status FROM distributor.shipment_legs WHERE shipment_id = $1", [leg.shipment_id]);
  const newStatus = computeShipmentStatus(allLegs.map((l) => l.status));
  await query("UPDATE distributor.shipments SET status = $1 WHERE id = $2", [newStatus, leg.shipment_id]);

  res.status(200).json({ ok: true, action, shipmentStatus: newStatus });
}

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  const legId = parseInt(req.query.legId, 10);
  if (!Number.isFinite(legId)) {
    res.status(400).json({ ok: false, error: "Invalid leg id" });
    return;
  }

  const { action } = req.query;
  if (action === "rollback") return handleRollback(req, res, legId);
  if (action === "scan") return handleScan(req, res, legId);
  if (action === "scan-item") return handleScanItem(req, res, legId, session);
  if (action === "finalize-scan") return handleFinalizeScan(req, res, legId, session);

  res.status(404).json({ ok: false, error: `Unknown action "${action}"` });
};
