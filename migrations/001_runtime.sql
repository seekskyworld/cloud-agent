-- 核心状态独立于业务表；同一任务的写入先锁 tasks 行，保证事件顺序及租约隔离。
CREATE TABLE principals (
  id text NOT NULL, workspace_id text NOT NULL, token_hash text UNIQUE NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE conversations (
  id uuid PRIMARY KEY, workspace_id text NOT NULL, principal_id text NOT NULL,
  title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,principal_id) REFERENCES principals(workspace_id,id)
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY, workspace_id text NOT NULL, principal_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  module_id text NOT NULL, module_version text NOT NULL, config_hash text NOT NULL,
  input jsonb NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','waiting_input','waiting_approval','waiting_external','retry_scheduled','succeeded','failed','cancelled')),
  result jsonb, error text, budget jsonb NOT NULL,
  model_calls integer NOT NULL DEFAULT 0, tool_calls integer NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0, execution_ms bigint NOT NULL DEFAULT 0,
  lease_token uuid, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,principal_id,request_key),
  FOREIGN KEY(workspace_id,principal_id) REFERENCES principals(workspace_id,id)
);
CREATE INDEX tasks_queue ON tasks(available_at,created_at) WHERE status IN ('queued','retry_scheduled','running');
CREATE TABLE messages (
  id bigserial PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id),
  task_id uuid NOT NULL REFERENCES tasks(id), role text NOT NULL, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE runs (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), lease_token uuid NOT NULL,
  engine_id text NOT NULL, status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz
);
CREATE TABLE steps (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), key text NOT NULL,
  kind text NOT NULL, request jsonb NOT NULL, request_hash text NOT NULL,
  status text NOT NULL, output jsonb, attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,key)
);
CREATE TABLE tool_invocations (
  id uuid PRIMARY KEY REFERENCES steps(id), task_id uuid NOT NULL REFERENCES tasks(id),
  tool_name text NOT NULL, tool_version text NOT NULL, effect text NOT NULL,
  status text NOT NULL, receipt text, reconciliation_ref text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invocation_attempts (
  id bigserial PRIMARY KEY, step_id uuid NOT NULL REFERENCES steps(id), run_id uuid NOT NULL REFERENCES runs(id),
  status text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, error_code text
);
CREATE TABLE waits (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), step_id uuid NOT NULL REFERENCES steps(id),
  kind text NOT NULL CHECK(kind IN ('input','approval','external')), reason text NOT NULL, schema jsonb NOT NULL,
  capability text, binding_hash text NOT NULL, status text NOT NULL DEFAULT 'pending', response jsonb,
  expires_at timestamptz NOT NULL, consumed_by text, UNIQUE(step_id)
);
CREATE TABLE inbound_events (
  id uuid PRIMARY KEY, workspace_id text NOT NULL, principal_id text NOT NULL,
  event_key text NOT NULL, request_hash text NOT NULL, wait_id uuid NOT NULL REFERENCES waits(id),
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,principal_id,event_key)
);
CREATE TABLE artifacts (
  id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES tasks(id), title text NOT NULL,
  media_type text NOT NULL DEFAULT 'application/json', content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE events (
  id bigserial PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_task_cursor ON events(task_id,id);
CREATE TABLE schedules (
  id uuid PRIMARY KEY, workspace_id text NOT NULL, principal_id text NOT NULL,
  module_id text NOT NULL, input jsonb NOT NULL, interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 60 AND 31536000),
  next_at timestamptz NOT NULL, enabled boolean NOT NULL DEFAULT true,
  FOREIGN KEY(workspace_id,principal_id) REFERENCES principals(workspace_id,id)
);
CREATE TABLE worker_heartbeats (id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
