CREATE TABLE IF NOT EXISTS users (
 id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator'))
);
CREATE TABLE IF NOT EXISTS leads (
 id UUID PRIMARY KEY, data JSONB NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id),
 version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads((data->>'status'));
CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads((data->>'phone'));
CREATE TABLE IF NOT EXISTS lead_events (
 id BIGSERIAL PRIMARY KEY, lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
 actor_id INTEGER NOT NULL REFERENCES users(id), description TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
