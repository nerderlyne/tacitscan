// Applies SQL migrations from ./drizzle/*.sql in lexicographic order.
// Tracks applied filenames in a `_migrations` table so re-runs are no-ops.
// After SQL migrations, runs idempotent code-level data fixes for things
// SQL can't easily express (e.g. "rederive every asset_id with the
// corrected byte order").
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { deriveAssetId } from "./envelope.js";

const MIGRATIONS_DIR = "./drizzle";

async function applySqlMigrations() {
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS _migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  for (const filename of files) {
    await db.transaction(async t => {
      await t.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await t.execute(sql`SELECT pg_advisory_xact_lock(81419)`);
      const applied = await t.execute(sql`SELECT 1 FROM _migrations WHERE filename=${filename}`);
      if (applied.length) return;
      console.log(`apply ${filename}`);
      const content = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
      const statements = content.split(/--\s*>?\s*statement-breakpoint|;\s*\n\s*\n/).map(s=>s.trim()).filter(Boolean);
      for (const statement of statements) await t.execute(sql.raw(statement));
      await t.execute(sql`INSERT INTO _migrations(filename) VALUES(${filename})`);
    });
  }
}

// One-shot fix for asset_id rows that were derived under the old byte-
// order bug. Idempotent: on a clean DB this is a no-op because every
// row already matches the canonical derivation.
async function backfillCorrectAssetIds() {
  const rows = await db.execute<{ asset_id: string; etch_txid: string }>(
    sql`SELECT asset_id, etch_txid FROM assets`,
  );
  let toFix: Array<{ oldId: string; newId: string }> = [];
  for (const r of rows) {
    const correct = deriveAssetId(r.etch_txid, 0);
    if (correct !== r.asset_id) toFix.push({ oldId: r.asset_id, newId: correct });
  }
  if (toFix.length === 0) {
    console.log("asset_ids: all rows already canonical, nothing to fix");
    return;
  }
  console.log(`asset_ids: rewriting ${toFix.length} stale rows…`);
  for (const { oldId, newId } of toFix) {
    await db.transaction(async (t) => {
      // Order matters only if FK constraints existed (they don't, so
      // this is for clarity): update children first, then the asset row.
      await t.execute(sql`UPDATE commitments SET asset_id = ${newId} WHERE asset_id = ${oldId}`);
      await t.execute(
        sql`UPDATE envelopes SET asset_id = ${newId} WHERE asset_id = ${oldId} AND opcode IN ('CETCH', 'T_PETCH')`,
      );
      await t.execute(sql`UPDATE assets SET asset_id = ${newId} WHERE asset_id = ${oldId}`);
    });
  }
  console.log(`asset_ids: rewrote ${toFix.length} rows`);
}

async function main() {
  await applySqlMigrations();
  if (process.env.LEGACY_ASSET_ID_REPAIR_ENABLED === "true") await backfillCorrectAssetIds();
  console.log("done");
  process.exit(0);
}

main().catch((e) => {
  console.error("migration failed:", e);
  process.exit(1);
});
