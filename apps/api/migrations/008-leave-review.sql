ALTER TABLE attendance DROP CONSTRAINT attendance_status_check;
ALTER TABLE attendance ADD CHECK(status IN ('attended','absent','unmarked','leave'));
ALTER TABLE makeup_credits ADD COLUMN billing_mode text NOT NULL DEFAULT 'on_attendance' CHECK(billing_mode IN ('on_attendance','prepaid'));
ALTER TABLE makeup_credits ADD COLUMN covered_units integer;
UPDATE makeup_credits m SET covered_units=l.debit FROM bookings b JOIN lessons l ON(l.tenant_id=b.tenant_id AND l.id=b.session_id) WHERE b.tenant_id=m.tenant_id AND b.id=m.origin_booking;
ALTER TABLE makeup_credits ALTER COLUMN covered_units SET NOT NULL;
ALTER TABLE makeup_credits ADD CHECK(covered_units>0);
CREATE TABLE leave_policy_versions (
 tenant_id text NOT NULL REFERENCES tenants(id), version integer NOT NULL CHECK(version>0),
 cutoff_minutes integer NOT NULL CHECK(cutoff_minutes BETWEEN 0 AND 10080), valid_days integer NOT NULL CHECK(valid_days BETWEEN 1 AND 365),
 charge boolean NOT NULL, reason text NOT NULL, actor_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,version)
);
CREATE TABLE leave_requests (
 tenant_id text NOT NULL, id text NOT NULL, booking_id text NOT NULL, requester_id text NOT NULL REFERENCES users(id),
 reason text NOT NULL, status text NOT NULL CHECK(status IN ('pending','approved','rejected','withdrawn','superseded')),
 version integer NOT NULL DEFAULT 1, policy jsonb NOT NULL, basis jsonb NOT NULL, charge boolean,
 decision_reason text, reviewed_by text REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,booking_id) REFERENCES bookings(tenant_id,id)
);
CREATE UNIQUE INDEX leave_one_pending ON leave_requests(tenant_id,booking_id) WHERE status='pending';
CREATE TABLE leave_events (
 tenant_id text NOT NULL, id text NOT NULL, request_id text NOT NULL, version integer NOT NULL, action text NOT NULL,
 reason text NOT NULL, charge boolean, actor_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,request_id,version), FOREIGN KEY(tenant_id,request_id) REFERENCES leave_requests(tenant_id,id)
);
CREATE TRIGGER leave_events_immutable BEFORE UPDATE OR DELETE ON leave_events FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER leave_policy_immutable BEFORE UPDATE OR DELETE ON leave_policy_versions FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
