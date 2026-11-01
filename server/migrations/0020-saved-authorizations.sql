CREATE TABLE saved_authorizations (
  authorization_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target text NOT NULL,
  target_label text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('win32','linux','darwin')),
  operation text NOT NULL CHECK (operation = 'read'),
  resource text NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('file','directory')),
  source_approval_id uuid REFERENCES approvals(approval_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX saved_authorizations_active ON saved_authorizations(user_id,target,operation,resource,resource_type) WHERE revoked_at IS NULL;
CREATE TABLE authorization_logs (
  log_id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  authorization_id uuid REFERENCES saved_authorizations(authorization_id),
  approval_id uuid REFERENCES approvals(approval_id) ON DELETE SET NULL,
  run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('grant','allow_once','reject','use','revoke')),
  target text NOT NULL,
  operation text NOT NULL,
  resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authorization_logs_user ON authorization_logs(user_id,log_id DESC);
