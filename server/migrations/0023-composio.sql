CREATE TABLE composio_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  base_url text NOT NULL DEFAULT '',
  secret jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO composio_config(singleton) VALUES (true);
