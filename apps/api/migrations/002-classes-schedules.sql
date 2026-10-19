CREATE TABLE classes (
  tenant_id text NOT NULL, id text NOT NULL, name text NOT NULL,
  course_id text NOT NULL, teacher_id text NOT NULL, room text NOT NULL,
  capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,course_id) REFERENCES courses(tenant_id,id),
  FOREIGN KEY(tenant_id,teacher_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE class_members (
  tenant_id text NOT NULL, class_id text NOT NULL, student_id text NOT NULL,
  PRIMARY KEY(tenant_id,class_id,student_id),
  FOREIGN KEY(tenant_id,class_id) REFERENCES classes(tenant_id,id),
  FOREIGN KEY(tenant_id,student_id) REFERENCES students(tenant_id,id)
);
CREATE TABLE schedule_series (
  tenant_id text NOT NULL, id text NOT NULL, class_id text NOT NULL, rule jsonb NOT NULL,
  created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,class_id) REFERENCES classes(tenant_id,id)
);
ALTER TABLE lessons ADD COLUMN class_id text;
ALTER TABLE lessons ADD COLUMN series_id text;
ALTER TABLE lessons ADD FOREIGN KEY(tenant_id,class_id) REFERENCES classes(tenant_id,id);
ALTER TABLE lessons ADD FOREIGN KEY(tenant_id,series_id) REFERENCES schedule_series(tenant_id,id);
CREATE INDEX lessons_series ON lessons(tenant_id,series_id,starts_at);
CREATE INDEX lessons_time ON lessons(tenant_id,starts_at,ends_at);
CREATE INDEX class_members_student ON class_members(tenant_id,student_id);
