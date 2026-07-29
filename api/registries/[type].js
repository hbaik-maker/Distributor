const { requireSession } = require("../_lib/session");
const { query } = require("../_lib/db");

// Consolidates gr-few-skus.js and kimchi-skus.js into one dynamic route —
// each extra file under api/ is its own Serverless Function, and the Hobby
// plan caps a deployment at 12 total (see INFRA_REFERENCE.md). Both
// registries are simple set-of-strings tables keyed differently only in
// column name, so a single handler covers both by `type`.
const REGISTRIES = {
  "gr-few": { table: "distributor.gr_few_skus", column: "sku", responseKey: "skus" },
  "kimchi": { table: "distributor.kimchi_skus", column: "identifier", responseKey: "identifiers" },
};

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  const registry = REGISTRIES[req.query.type];
  if (!registry) {
    res.status(404).json({ ok: false, error: `Unknown registry type "${req.query.type}"` });
    return;
  }
  const { table, column, responseKey } = registry;

  if (req.method === "GET") {
    const { rows } = await query(`SELECT ${column} FROM ${table} ORDER BY ${column}`);
    res.status(200).json({ ok: true, [responseKey]: rows.map((r) => r[column]) });
    return;
  }

  if (req.method === "PUT") {
    // Bulk merge: only add/remove entries this run actually touched, so
    // another run's registry state (not in either list) is left untouched.
    const add = Array.isArray(req.body && req.body.add) ? req.body.add.filter((s) => typeof s === "string" && s) : [];
    const remove = Array.isArray(req.body && req.body.remove) ? req.body.remove.filter((s) => typeof s === "string" && s) : [];
    if (add.length) {
      await query(
        `INSERT INTO ${table} (${column}) SELECT * FROM UNNEST($1::text[]) ON CONFLICT (${column}) DO NOTHING`,
        [add]
      );
    }
    if (remove.length) {
      await query(`DELETE FROM ${table} WHERE ${column} = ANY($1::text[])`, [remove]);
    }
    const { rows } = await query(`SELECT ${column} FROM ${table} ORDER BY ${column}`);
    res.status(200).json({ ok: true, [responseKey]: rows.map((r) => r[column]) });
    return;
  }

  res.status(405).json({ ok: false, error: "Method not allowed" });
};
