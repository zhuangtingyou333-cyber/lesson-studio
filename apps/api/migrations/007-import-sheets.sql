ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS worksheet text;
ALTER TABLE import_batches DISABLE TRIGGER import_completed_immutable;
UPDATE import_batches SET worksheet=COALESCE(config->>'sheet',document->'sheets'->0->>'name') WHERE worksheet IS NULL;
ALTER TABLE import_batches ENABLE TRIGGER import_completed_immutable;
ALTER TABLE import_batches ALTER COLUMN worksheet SET NOT NULL;
ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_tenant_id_file_hash_key;
CREATE UNIQUE INDEX IF NOT EXISTS import_batch_sheet_unique ON import_batches(tenant_id,file_hash,worksheet);
