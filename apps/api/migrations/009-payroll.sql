CREATE TABLE payroll_rules (
 tenant_id text NOT NULL, id text NOT NULL, teacher_id text NOT NULL, course_id text NOT NULL,
 version integer NOT NULL CHECK(version>0), effective_from date NOT NULL,
 mode text NOT NULL CHECK(mode IN ('lesson','student')), rate integer NOT NULL CHECK(rate BETWEEN 0 AND 100000000),
 count_absent boolean NOT NULL, count_makeup boolean NOT NULL, reason text NOT NULL, actor_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,teacher_id,course_id,version),
 FOREIGN KEY(tenant_id,teacher_id) REFERENCES memberships(tenant_id,user_id), FOREIGN KEY(tenant_id,course_id) REFERENCES courses(tenant_id,id)
);
CREATE TABLE payroll_periods (
 tenant_id text NOT NULL, id text NOT NULL, teacher_id text NOT NULL, month text NOT NULL CHECK(month~'^[0-9]{4}-(0[1-9]|1[0-2])$'),
 status text NOT NULL CHECK(status IN ('draft','frozen')), version integer NOT NULL DEFAULT 1, snapshot jsonb NOT NULL, fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), frozen_at timestamptz, frozen_by text REFERENCES users(id), freeze_reason text,
 seq bigint GENERATED ALWAYS AS IDENTITY, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,teacher_id,month), FOREIGN KEY(tenant_id,teacher_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE payroll_sources (
 tenant_id text NOT NULL, lesson_id text NOT NULL, period_id text NOT NULL, teacher_id text NOT NULL, amount bigint NOT NULL CHECK(amount>=0), snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,lesson_id), FOREIGN KEY(tenant_id,lesson_id) REFERENCES lessons(tenant_id,id), FOREIGN KEY(tenant_id,period_id) REFERENCES payroll_periods(tenant_id,id)
);
CREATE TABLE payroll_adjustments (
 tenant_id text NOT NULL, id text NOT NULL, lesson_id text NOT NULL, source_period_id text NOT NULL, teacher_id text NOT NULL,
 amount bigint NOT NULL CHECK(amount<>0), before_amount bigint NOT NULL, after_amount bigint NOT NULL, eligible_month text NOT NULL,
 trigger_booking text NOT NULL, trigger_revision integer NOT NULL, snapshot jsonb NOT NULL, reason text NOT NULL, actor_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 seq bigint GENERATED ALWAYS AS IDENTITY, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,trigger_booking,trigger_revision),
 FOREIGN KEY(tenant_id,lesson_id) REFERENCES payroll_sources(tenant_id,lesson_id), FOREIGN KEY(tenant_id,source_period_id) REFERENCES payroll_periods(tenant_id,id),
 FOREIGN KEY(tenant_id,trigger_booking) REFERENCES bookings(tenant_id,id), CHECK(amount=after_amount-before_amount)
);
CREATE TABLE payroll_applied_adjustments (
 tenant_id text NOT NULL, adjustment_id text NOT NULL, period_id text NOT NULL,
 PRIMARY KEY(tenant_id,adjustment_id), FOREIGN KEY(tenant_id,adjustment_id) REFERENCES payroll_adjustments(tenant_id,id), FOREIGN KEY(tenant_id,period_id) REFERENCES payroll_periods(tenant_id,id)
);
CREATE TRIGGER payroll_rules_immutable BEFORE UPDATE OR DELETE ON payroll_rules FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER payroll_sources_immutable BEFORE UPDATE OR DELETE ON payroll_sources FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER payroll_adjustments_immutable BEFORE UPDATE OR DELETE ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER payroll_applied_immutable BEFORE UPDATE OR DELETE ON payroll_applied_adjustments FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE FUNCTION reject_frozen_payroll_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status='frozen' THEN RAISE EXCEPTION 'frozen payroll is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER payroll_frozen_immutable BEFORE UPDATE OR DELETE ON payroll_periods FOR EACH ROW EXECUTE FUNCTION reject_frozen_payroll_mutation();
CREATE INDEX payroll_pending_adjustments ON payroll_adjustments(tenant_id,teacher_id,eligible_month,seq);
