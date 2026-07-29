const { requireSession } = require("./_lib/session");
const { query } = require("./_lib/db");

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === "GET") {
    const { rows } = await query("SELECT sku FROM distributor.gr_few_skus ORDER BY sku");
    res.status(200).json({ ok: true, skus: rows.map((r) => r.sku) });
    return;
  }

  if (req.method === "PUT") {
    // Bulk merge: only add/remove SKUs this run actually touched, so
    // another run's GR_Few state (not in either list) is left untouched —
    // mirrors the Flask app's per-item merge in _apply_form_to_items.
    const add = Array.isArray(req.body && req.body.add) ? req.body.add.filter((s) => typeof s === "string" && s) : [];
    const remove = Array.isArray(req.body && req.body.remove) ? req.body.remove.filter((s) => typeof s === "string" && s) : [];
    // No transaction wrapper needed — each statement is independently
    // idempotent (ON CONFLICT DO NOTHING / no-op delete).
    if (add.length) {
      await query(
        `INSERT INTO distributor.gr_few_skus (sku) SELECT * FROM UNNEST($1::text[]) ON CONFLICT (sku) DO NOTHING`,
        [add]
      );
    }
    if (remove.length) {
      await query(`DELETE FROM distributor.gr_few_skus WHERE sku = ANY($1::text[])`, [remove]);
    }
    const { rows } = await query("SELECT sku FROM distributor.gr_few_skus ORDER BY sku");
    res.status(200).json({ ok: true, skus: rows.map((r) => r.sku) });
    return;
  }

  res.status(405).json({ ok: false, error: "Method not allowed" });
};
