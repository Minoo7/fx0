-- A sponsored guest chat has no customer billing team. Existing team ownership
-- and each paid turn's billing team retain their current values.
ALTER TABLE fx0_chat_ownership ALTER COLUMN billing_team_id DROP NOT NULL;
