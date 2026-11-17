ALTER TABLE devices ADD COLUMN hardware_fingerprint text CHECK (hardware_fingerprint ~ '^v1:[a-f0-9]{64}$');
ALTER TABLE devices ADD COLUMN key_version integer NOT NULL DEFAULT 0;
CREATE INDEX devices_fingerprint ON devices(user_id,hardware_fingerprint) WHERE revoked_at IS NULL;
CREATE TABLE device_key_rotations (
  rotation_id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(device_id),
  user_id uuid NOT NULL REFERENCES users(user_id), old_key_hash text NOT NULL,
  new_key_hash text NOT NULL, key_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bot_messages ADD COLUMN provenance jsonb NOT NULL DEFAULT '{"client":"unknown"}';
UPDATE bot_messages m SET provenance=CASE WHEN r.source_client IN ('android','ios') THEN jsonb_build_object('client',r.source_client,'entry','cloud') ELSE jsonb_build_object('client',r.source_client,'device_id',r.source_device_id,'device_label',d.label) END
FROM bot_runs r LEFT JOIN devices d ON d.device_id=r.source_device_id
WHERE m.run_id=r.run_id AND m.role='user' AND r.source_client<>'legacy';
CREATE TABLE endpoint_experiences (
  evidence_id uuid PRIMARY KEY, bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES bot_runs(run_id), target text NOT NULL,
  resolved_by uuid REFERENCES endpoint_experiences(evidence_id),
  capability text NOT NULL, path text, outcome text NOT NULL CHECK(outcome IN ('observed','conflict')),
  evidence jsonb NOT NULL, verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX endpoint_experiences_bot ON endpoint_experiences(bot_id,verified_at DESC);
