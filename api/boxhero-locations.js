const { requireSession } = require("./_lib/session");
const { listLocations } = require("./_lib/boxhero");

module.exports = async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const locations = await listLocations();
    res.status(200).json({ ok: true, locations: locations.map((l) => ({ id: l.id, name: l.name })) });
  } catch (e) {
    res.status(502).json({ ok: false, error: `Could not load BoxHero locations: ${e.message}` });
  }
};
