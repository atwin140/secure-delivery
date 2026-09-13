import type { Database } from "./db";
import { audit } from "./db";
export async function safeRestoreInvalidate(db: Database) {
  await db.transaction(async (q) => {
    await q.query(
      "UPDATE settings SET value=false WHERE key='retrieval_enabled'",
    );
    await q.query(
      "UPDATE repositories SET status='revoked',invalidated_at=COALESCE(invalidated_at,clock_timestamp()),upload_lease=NULL,deleted_at=NULL",
    );
    await q.query("DELETE FROM sessions");
    await q.query("DELETE FROM oidc_transactions");
    await audit(q, null, "restore_all_deliveries_invalidated", "success");
  });
}
