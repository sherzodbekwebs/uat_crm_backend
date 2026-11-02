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


CREATE TABLE IF NOT EXISTS instagram_accounts (
 id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
 ig_user_id TEXT NOT NULL UNIQUE,
 username TEXT NOT NULL,
 access_token_encrypted TEXT NOT NULL,
 token_expires_at TIMESTAMPTZ,
 webhook_subscribed BOOLEAN NOT NULL DEFAULT FALSE,
 connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instagram_conversations (
 id BIGSERIAL PRIMARY KEY,
 ig_user_id TEXT NOT NULL REFERENCES instagram_accounts(ig_user_id) ON DELETE CASCADE ON UPDATE CASCADE,
 sender_id TEXT NOT NULL,
 sender_username TEXT NOT NULL DEFAULT '',
 last_message_text TEXT NOT NULL DEFAULT '',
 last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_inbound_at TIMESTAMPTZ,
 unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE (ig_user_id, sender_id)
);
CREATE INDEX IF NOT EXISTS instagram_conversations_recent_idx ON instagram_conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS instagram_conversations_sender_idx ON instagram_conversations(sender_id);

CREATE TABLE IF NOT EXISTS instagram_messages (
 id BIGSERIAL PRIMARY KEY,
 conversation_id BIGINT NOT NULL REFERENCES instagram_conversations(id) ON DELETE CASCADE,
 external_message_id TEXT NOT NULL UNIQUE,
 direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
 message_text TEXT NOT NULL DEFAULT '',
 attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
 sent_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS instagram_messages_conversation_idx ON instagram_messages(conversation_id, sent_at DESC, id DESC);
