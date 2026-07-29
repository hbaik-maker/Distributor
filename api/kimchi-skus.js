const { requireSession } = require("./_lib/session");
const { query } = require("./_lib/db");

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === "GET") {
    const { rows } = await query("SELECT identifier FROM distributor.kimchi_skus ORDER BY identifier");
    res.status(200).json({ ok: true, identifiers: rows.map((r) => r.identifier) });
    return;
  }

  if (req.method === "PUT") {
    // Bulk merge: only add/remove identifiers this run actually touched, so
    // another run's 김치 state (not in either list) is left untouched —
    // mirrors gr-few-skus.js. An identifier here is either a SKU or a
    // barcode; matching against either field is done client-side.
    const add = Array.isArray(req.body && req.body.add) ? req.body.add.filter((s) => typeof s === "string" && s) : [];
    const remove = Array.isArray(req.body && req.body.remove) ? req.body.remove.filter((s) => typeof s === "string" && s) : [];
    if (add.length) {
      await query(
        `INSERT INTO distributor.kimchi_skus (identifier) SELECT * FROM UNNEST($1::text[]) ON CONFLICT (identifier) DO NOTHING`,
        [add]
      );
    }
    if (remove.length) {
      await query(`DELETE FROM distributor.kimchi_skus WHERE identifier = ANY($1::text[])`, [remove]);
    }
    const { rows } = await query("SELECT identifier FROM distributor.kimchi_skus ORDER BY identifier");
    res.status(200).json({ ok: true, identifiers: rows.map((r) => r.identifier) });
    return;
  }

  res.status(405).json({ ok: false, error: "Method not allowed" });
};
