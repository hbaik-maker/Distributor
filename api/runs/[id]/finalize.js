const { requireSession } = require("../../_lib/session");
const { query } = require("../../_lib/db");
const { insertItems } = require("../../_lib/itemMapping");

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const runId = parseInt(req.query.id, 10);
  if (!Number.isFinite(runId)) {
    res.status(400).json({ ok: false, error: "Invalid run id" });
    return;
  }

  const { rows: existing } = await query("SELECT status FROM distributor.runs WHERE id = $1", [runId]);
  if (!existing.length) {
    res.status(404).json({ ok: false, error: "Run not found" });
    return;
  }
  if (existing[0].status !== "pending") {
    res.status(200).json({ ok: true, alreadyFinalized: true });
    return;
  }

  const { settings, items } = req.body || {};
  if (settings) {
    await query("UPDATE distributor.runs SET settings_json = $1 WHERE id = $2", [JSON.stringify(settings), runId]);
  }
  if (Array.isArray(items)) {
    await query("DELETE FROM distributor.run_items WHERE run_id = $1", [runId]);
    await insertItems(query, runId, items);
  }
  await query("UPDATE distributor.runs SET status = 'finalized', finalized_at = now() WHERE id = $1", [runId]);
  res.status(200).json({ ok: true });
};
