const { requireSession } = require("../_lib/session");
const { query } = require("../_lib/db");
const { rowToItem, insertItems } = require("../_lib/itemMapping");

function rowToMeta(row) {
  return {
    id: row.id,
    sourceFilename: row.source_filename,
    createdAt: row.created_at,
    status: row.status,
    finalizedAt: row.finalized_at,
    settings: row.settings_json,
  };
}

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  const runId = parseInt(req.query.id, 10);
  if (!Number.isFinite(runId)) {
    res.status(400).json({ ok: false, error: "Invalid run id" });
    return;
  }

  if (req.method === "GET") {
    const { rows: runRows } = await query("SELECT * FROM distributor.runs WHERE id = $1", [runId]);
    if (!runRows.length) {
      res.status(404).json({ ok: false, error: "Run not found" });
      return;
    }
    const { rows: itemRows } = await query("SELECT * FROM distributor.run_items WHERE run_id = $1 ORDER BY sku", [runId]);
    res.status(200).json({ ok: true, meta: rowToMeta(runRows[0]), items: itemRows.map(rowToItem) });
    return;
  }

  if (req.method === "PUT") {
    const { rows: existing } = await query("SELECT status FROM distributor.runs WHERE id = $1", [runId]);
    if (!existing.length) {
      res.status(404).json({ ok: false, error: "Run not found" });
      return;
    }
    if (existing[0].status !== "pending") {
      res.status(409).json({ ok: false, error: "This run is already finalized and can no longer be edited." });
      return;
    }
    const { settings, items } = req.body || {};
    if (settings) {
      await query("UPDATE distributor.runs SET settings_json = $1 WHERE id = $2", [JSON.stringify(settings), runId]);
    }
    if (Array.isArray(items)) {
      // Simplest correct approach for a few-thousand-row, infrequent,
      // user-triggered save: replace wholesale rather than diff per field.
      await query("DELETE FROM distributor.run_items WHERE run_id = $1", [runId]);
      await insertItems(query, runId, items);
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === "DELETE") {
    const { rows: shipmentRows } = await query("SELECT id FROM distributor.shipments WHERE run_id = $1", [runId]);
    if (shipmentRows.length) {
      res.status(409).json({ ok: false, error: "This run has a shipment (planned or executed) and can no longer be deleted — it may reference a real BoxHero transaction." });
      return;
    }
    await query("DELETE FROM distributor.runs WHERE id = $1", [runId]);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ ok: false, error: "Method not allowed" });
};
