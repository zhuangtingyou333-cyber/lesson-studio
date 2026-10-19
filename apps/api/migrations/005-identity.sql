ALTER TABLE memberships ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE auth_sessions ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE auth_sessions ADD FOREIGN KEY(user_id) REFERENCES users(id);
CREATE TABLE identity_guards(user_id text PRIMARY KEY REFERENCES users(id));
INSERT INTO identity_guards SELECT id FROM users;
CREATE TABLE external_identities (
  provider text NOT NULL CHECK(provider='wechat'), app_id text NOT NULL, subject text NOT NULL,
  user_id text NOT NULL REFERENCES users(id), PRIMARY KEY(provider,app_id,subject)
);
CREATE TABLE login_codes(app_id text NOT NULL, code_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(app_id,code_hash));
CREATE TABLE identity_commands(user_id text NOT NULL REFERENCES users(id), key text NOT NULL, hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key));
CREATE TABLE invitations (
  tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, role text NOT NULL CHECK(role IN ('teacher','guardian')),
  token_hash text NOT NULL UNIQUE, label text NOT NULL, expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','claimed','revoked')),
  version integer NOT NULL DEFAULT 1, created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE invitation_students (
  tenant_id text NOT NULL, invitation_id text NOT NULL, student_id text NOT NULL,
  PRIMARY KEY(tenant_id,invitation_id,student_id), FOREIGN KEY(tenant_id,invitation_id) REFERENCES invitations(tenant_id,id),
  FOREIGN KEY(tenant_id,student_id) REFERENCES students(tenant_id,id)
);
CREATE TABLE membership_claims (
  tenant_id text NOT NULL, id text NOT NULL, invitation_id text NOT NULL, user_id text NOT NULL REFERENCES users(id),
  display_name text NOT NULL, relationship text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  version integer NOT NULL DEFAULT 1, decided_by text REFERENCES users(id), decision_reason text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,invitation_id), FOREIGN KEY(tenant_id,invitation_id) REFERENCES invitations(tenant_id,id)
);
