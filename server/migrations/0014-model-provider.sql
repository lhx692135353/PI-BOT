-- Known providers keep their own base URL. Voice is explicit and optional.
ALTER TABLE models ADD COLUMN provider text NOT NULL DEFAULT 'custom';
ALTER TABLE models ADD COLUMN voice_model text;
ALTER TABLE models ADD CONSTRAINT models_provider CHECK (provider IN ('xai', 'bailian', 'custom'));

UPDATE models SET provider = 'xai' WHERE base_url ~* '://([^/]+\.)?x\.ai(:[0-9]+)?(/|$)';
UPDATE models SET provider = 'bailian'
  WHERE provider = 'custom' AND base_url ~* '://([^/]+\.)?dashscope(-intl)?\.(aliyuncs|aliyun)\.com(:[0-9]+)?(/|$)';
-- Existing xAI rows were already calling grok-voice-latest. Keep that choice visible and clearable.
UPDATE models SET voice_model = 'grok-voice-latest' WHERE provider = 'xai' AND voice_model IS NULL;
