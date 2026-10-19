ALTER TABLE students ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE courses ADD COLUMN active boolean NOT NULL DEFAULT true, ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE packages ADD COLUMN active boolean NOT NULL DEFAULT true, ADD COLUMN version integer NOT NULL DEFAULT 1;

CREATE TABLE rooms (
  tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, name text NOT NULL,
  capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 200), active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,name)
);
INSERT INTO rooms(tenant_id,id,name,capacity)
SELECT tenant_id,'migrated-'||md5(tenant_id||'|'||room),room,max(capacity)
FROM (SELECT tenant_id,room,capacity FROM lessons UNION ALL SELECT tenant_id,room,capacity FROM classes) r
GROUP BY tenant_id,room;
ALTER TABLE lessons ADD COLUMN room_id text;
ALTER TABLE classes ADD COLUMN room_id text;
UPDATE lessons l SET room_id=r.id FROM rooms r WHERE r.tenant_id=l.tenant_id AND r.name=l.room;
UPDATE classes k SET room_id=r.id FROM rooms r WHERE r.tenant_id=k.tenant_id AND r.name=k.room;
ALTER TABLE lessons ALTER COLUMN room_id SET NOT NULL, ADD FOREIGN KEY(tenant_id,room_id) REFERENCES rooms(tenant_id,id);
ALTER TABLE classes ALTER COLUMN room_id SET NOT NULL, ADD FOREIGN KEY(tenant_id,room_id) REFERENCES rooms(tenant_id,id);
CREATE INDEX lesson_room_time ON lessons(tenant_id,room_id,starts_at,ends_at);

CREATE TABLE package_versions (
  tenant_id text NOT NULL, package_id text NOT NULL, version integer NOT NULL,
  definition jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,package_id,version), FOREIGN KEY(tenant_id,package_id) REFERENCES packages(tenant_id,id)
);
INSERT INTO package_versions(tenant_id,package_id,version,definition) SELECT tenant_id,id,version,to_jsonb(p) FROM packages p;
CREATE FUNCTION record_package_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO package_versions(tenant_id,package_id,version,definition) VALUES(NEW.tenant_id,NEW.id,NEW.version,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER package_version_record AFTER INSERT OR UPDATE ON packages FOR EACH ROW EXECUTE FUNCTION record_package_version();
CREATE TRIGGER package_version_immutable BEFORE UPDATE OR DELETE ON package_versions FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
ALTER TABLE grants ADD COLUMN template_id text, ADD COLUMN template_version integer, ADD COLUMN template_snapshot jsonb;
ALTER TABLE grants ADD CHECK((template_id IS NULL AND template_version IS NULL AND template_snapshot IS NULL) OR (template_id IS NOT NULL AND template_version IS NOT NULL AND template_snapshot IS NOT NULL));
ALTER TABLE grants ADD FOREIGN KEY(tenant_id,template_id,template_version) REFERENCES package_versions(tenant_id,package_id,version);
