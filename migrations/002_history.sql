ALTER TABLE fx0_chat_ownership ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE fx0_chat_ownership ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS fx0_turns (
  session_id text NOT NULL REFERENCES fx0_chat_ownership(session_id) ON DELETE CASCADE,
  turn_id integer NOT NULL CHECK (turn_id > 0),
  prompt text NOT NULL,
  response text NOT NULL,
  model text NOT NULL,
  effort text,
  fast boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('done', 'error')),
  stop_reason text,
  input_tokens integer,
  output_tokens integer,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, turn_id)
);

CREATE TABLE IF NOT EXISTS fx0_generations (
  session_id text NOT NULL REFERENCES fx0_chat_ownership(session_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  turn_id integer,
  html text NOT NULL,
  bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, revision)
);

-- Turns and generations are keyed by chat and take their owner from fx0_chat_ownership,
-- so deleting a chat (or its account) cascades through its whole history.
