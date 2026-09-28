ALTER TABLE tasks ADD COLUMN trace_context jsonb;
CREATE TABLE cost_reservations (
  scope text NOT NULL, invocation text NOT NULL, workspace_id text NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id),
  period date NOT NULL, reserved double precision NOT NULL CHECK(reserved>=0), charged double precision CHECK(charged>=0),
  category text NOT NULL DEFAULT 'pending' CHECK(category IN ('pending','reported','estimated','reconciled')),
  reason text, receipt text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,invocation)
);
CREATE INDEX cost_reservations_period_idx ON cost_reservations(scope,period);
