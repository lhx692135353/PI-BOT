-- Optional provider-native search. Off keeps the shared Tavily tool.
ALTER TABLE models ADD COLUMN provider_search boolean NOT NULL DEFAULT false;
