const { requireSession } = require("./_lib/session");
const { query } = require("./_lib/db");
const { insertItems } = require("./_lib/itemMapping");
const { buildDatasource } = require("./_lib/tari");

function rowToMeta(row) {
  return {
    id: row.id,
    sourceFilename: row.source_filename,
    createdAt: row.created_at,
    status: row.status,
    finalizedAt: row.finalized_at,
    settings: row.settings_json,
    itemCount: Number(row.item_count) || 0,
  };
}

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === "GET" && req.query.action === "tari-datasource") {
    try {
      const { boxhero, scm, fetchedAt } = await buildDatasource();
      res.status(200).json({ ok: true, boxhero, scm, fetchedAt });
    } catch (e) {
      res.status(502).json({ ok: false, error: `Could not fetch data from Tari: ${e.message}` });
    }
    return;
  }

  if (req.method === "GET") {
    const { rows } = await query(`
      SELECT r.*, (SELECT COUNT(*) FROM distributor.run_items ri WHERE ri.run_id = r.id) AS item_count
      FROM distributor.runs r
      ORDER BY r.created_at DESC
    `);
    res.status(200).json({ ok: true, runs: rows.map(rowToMeta) });
    return;
  }

  if (req.method === "POST") {
    const { sourceFilename, settings, items } = req.body || {};
    if (!sourceFilename || !Array.isArray(items)) {
      res.status(400).json({ ok: false, error: "sourceFilename and items[] are required" });
      return;
    }
    const { rows } = await query(
      `INSERT INTO distributor.runs (source_filename, status, settings_json) VALUES ($1, 'pending', $2) RETURNING id, created_at`,
      [sourceFilename, JSON.stringify(settings || {})]
    );
    const runId = rows[0].id;
    try {
      await insertItems(query, runId, items);
    } catch (e) {
      // Clean up the orphaned run header if item insertion fails partway.
      await query("DELETE FROM distributor.runs WHERE id = $1", [runId]);
      throw e;
    }
    res.status(200).json({ ok: true, id: runId, createdAt: rows[0].created_at });
    return;
  }

  res.status(405).json({ ok: false, error: "Method not allowed" });
};
