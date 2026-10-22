ALTER TABLE bot_messages ADD COLUMN images jsonb NOT NULL DEFAULT '[]'::jsonb;
