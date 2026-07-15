-- Logical-replication publication that the self-hosted PowerSync service reads
-- from (see powersync/config.yaml -> replication.connections). Without it the
-- service fails with PSYNC_S1141 and no sync config becomes active.
--
-- Postgres has no `CREATE PUBLICATION IF NOT EXISTS`, so guard it so the
-- migration is idempotent (e.g. if the publication was created by hand first).
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN
		CREATE PUBLICATION powersync FOR ALL TABLES;
	END IF;
END $$;
