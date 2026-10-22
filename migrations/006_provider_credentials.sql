CREATE TABLE IF NOT EXISTS fx0_provider_credentials (
  provider_id text PRIMARY KEY,
  credential_type text NOT NULL,
  credential text NOT NULL
);
