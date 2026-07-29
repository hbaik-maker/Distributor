const { Pool } = require("pg");

// Reused across warm serverless invocations (module-level singleton) — the
// Transaction-mode pooler on port 6543 is what makes this safe to open per
// function instance without exhausting Supabase's connection limit.
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function query(text, params) {
  const client = getPool();
  return client.query(text, params);
}

module.exports = { query };
