CREATE TABLE IF NOT EXISTS fx0_accounts (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  name text NOT NULL,
  email text,
  picture text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fx0_chat_ownership (
  session_id text PRIMARY KEY CHECK (session_id ~ '^[a-z0-9-]{1,40}$'),
  user_id text NOT NULL REFERENCES fx0_accounts(id) ON DELETE CASCADE,
  billing_team_id text NOT NULL CHECK (billing_team_id ~ '^team_'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fx0_chat_ownership_user_idx ON fx0_chat_ownership(user_id, created_at DESC);

-- No Redis backfill: legacy chats have no owner and remain inaccessible.
