ALTER TABLE lessons ADD COLUMN status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled'));
CREATE TABLE lesson_changes (
  tenant_id text NOT NULL, id text NOT NULL, session_id text NOT NULL,
  version integer NOT NULL, action text NOT NULL CHECK(action IN ('reschedule','cancel')),
  reason text NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
  actor_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,session_id,version),
  FOREIGN KEY(tenant_id,session_id) REFERENCES lessons(tenant_id,id)
);
CREATE TRIGGER lesson_changes_immutable BEFORE UPDATE OR DELETE ON lesson_changes FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
