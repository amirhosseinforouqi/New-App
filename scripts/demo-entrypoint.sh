#!/bin/sh
# Demo entrypoint — brings the portal up from nothing in one command.
#
# Waits for Postgres, applies migrations, sets the application role's password,
# seeds demo data, then starts the server. Every step is idempotent, so
# restarting the container is safe and re-seeds cleanly.
#
# Used only by docker-compose.demo.yml. The production compose file does NOT
# use this — there, migrations are a deliberate, separate step you run and
# watch, rather than something that fires automatically on boot.

set -e

echo "[demo] waiting for postgres..."
i=0
until node -e "
  const pg = require('pg');
  const c = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  c.connect().then(() => c.end()).catch(() => process.exit(1));
" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[demo] postgres did not become ready in 60s" >&2
    exit 1
  fi
  sleep 1
done
echo "[demo] postgres ready"

echo "[demo] applying migrations..."
npx tsx scripts/migrate.ts

# The migration creates uwa_app but deliberately does not set its password —
# it is not the migration's business to know one. Set it here so the app can
# connect as the unprivileged role that row-level security actually applies to.
echo "[demo] setting application role password..."
node -e "
  const pg = require('pg');
  const c = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  c.connect()
    .then(() => c.query(\"ALTER ROLE uwa_app WITH LOGIN PASSWORD 'demopw'\"))
    .then(() => c.end())
    .then(() => console.log('[demo] role configured'))
    .catch((e) => { console.error(e.message); process.exit(1); });
"

echo "[demo] seeding demo data..."
npx tsx scripts/demo-seed.ts

echo ""
echo "  ─────────────────────────────────────────────────────────"
echo "   UWA is running at http://localhost:3000"
echo ""
echo "   Client (mid-file)     pramanathan / demo-portal-2026"
echo "   Client (new enquiry)  mdelacroixwebb / demo-portal-2026"
echo "   Broker                demo.broker@example.test / demo-portal-2026"
echo "  ─────────────────────────────────────────────────────────"
echo ""

exec npx next dev -p 3000 -H 0.0.0.0
