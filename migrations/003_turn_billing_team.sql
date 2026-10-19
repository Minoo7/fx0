ALTER TABLE fx0_turns ADD COLUMN IF NOT EXISTS billing_team_id text;

-- A chat can continue under any team the owner switches to, so each turn records
-- the team it actually billed. fx0_chat_ownership.billing_team_id is the team the
-- chat started with.
