CREATE TABLE jev_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  managed boolean NOT NULL DEFAULT false,
  base_url text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT 'jev-latest',
  secret jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO jev_config(singleton) VALUES (true);
