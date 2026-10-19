CREATE TABLE import_batches (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, file_name text NOT NULL, file_hash text NOT NULL,
 document jsonb NOT NULL, config jsonb, preview jsonb, preview_hash text,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','invalid','ready','completed')), version integer NOT NULL DEFAULT 1,
 created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 seq bigint GENERATED ALWAYS AS IDENTITY, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,file_hash)
);
CREATE TABLE import_student_links (
 tenant_id text NOT NULL, source text NOT NULL, external_key text NOT NULL, student_id text NOT NULL,
 PRIMARY KEY(tenant_id,source,external_key), FOREIGN KEY(tenant_id,student_id) REFERENCES students(tenant_id,id)
);
CREATE TABLE import_rows (
 tenant_id text NOT NULL, batch_id text NOT NULL, line integer NOT NULL, source text NOT NULL, external_key text, student_id text NOT NULL,
 grant_id text, snapshot jsonb NOT NULL, PRIMARY KEY(tenant_id,batch_id,line),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES import_batches(tenant_id,id), FOREIGN KEY(tenant_id,student_id) REFERENCES students(tenant_id,id),
 FOREIGN KEY(tenant_id,grant_id) REFERENCES grants(tenant_id,id), UNIQUE(tenant_id,source,external_key)
);
CREATE TRIGGER import_rows_immutable BEFORE UPDATE OR DELETE ON import_rows FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE FUNCTION protect_completed_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='completed' THEN RAISE EXCEPTION 'completed import is immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER import_completed_immutable BEFORE UPDATE OR DELETE ON import_batches FOR EACH ROW EXECUTE FUNCTION protect_completed_import();
ALTER TABLE grants DROP CONSTRAINT grants_purchased_check;
ALTER TABLE grants ADD CHECK(purchased>=0), ADD CHECK(purchased+gift>0);
