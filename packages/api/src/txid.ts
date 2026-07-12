import { sql } from 'drizzle-orm';
import { db } from '@app/db';

// The transaction object passed to db.transaction(async (tx) => ...).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Returns the Postgres transaction id of the current transaction. Calling
 * pg_current_xact_id() assigns a real xid to the transaction, which ElectricSQL
 * then surfaces in its shape stream — letting an Electric collection match an
 * optimistic write against the synced row. Must run inside the same transaction
 * as the write it should be associated with.
 */
export async function getTxid(tx: Tx): Promise<number> {
  const result = await tx.execute(sql`SELECT pg_current_xact_id()::xid::text AS txid`);
  const rows = result as unknown as Array<{ txid: string }>;
  const txid = rows[0]?.txid;
  if (txid == null) {
    throw new Error('Failed to obtain transaction id');
  }
  return Number.parseInt(txid, 10);
}
