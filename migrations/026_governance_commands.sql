ALTER TABLE business_jobs ADD COLUMN enabled boolean NOT NULL DEFAULT true;
CREATE TABLE governance_commands (
  workspace_id text NOT NULL, command_key text NOT NULL, request_hash text NOT NULL,
  principal_id text NOT NULL, kind text NOT NULL, target text NOT NULL, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,command_key)
);
CREATE TABLE token_audit (
  id bigserial PRIMARY KEY, workspace_id text NOT NULL, principal_id text NOT NULL,
  token_id uuid NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
