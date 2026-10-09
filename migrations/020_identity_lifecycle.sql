CREATE TABLE principal_tokens(
  id uuid PRIMARY KEY,workspace_id text NOT NULL,principal_id text NOT NULL,token_hash text UNIQUE NOT NULL,
  name text NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,principal_id) REFERENCES principals(workspace_id,id)
);
CREATE TABLE delegations(
  id uuid PRIMARY KEY,workspace_id text NOT NULL,owner_id text NOT NULL,delegate_id text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id),actions text[] NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,
  reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,owner_id) REFERENCES principals(workspace_id,id),
  FOREIGN KEY(workspace_id,delegate_id) REFERENCES principals(workspace_id,id)
);
CREATE TABLE delegation_audit(id bigserial PRIMARY KEY,delegation_id uuid NOT NULL,actor text NOT NULL,action text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
