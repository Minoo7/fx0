CREATE INDEX IF NOT EXISTS fx0_chat_ownership_activity_idx ON fx0_chat_ownership(user_id, updated_at DESC, session_id DESC) WHERE title IS NOT NULL;
