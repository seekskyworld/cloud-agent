-- 快照只追加，不随重试替换内容；读取/使用快照仍须重新通过领域授权。
CREATE TABLE context_snapshots (
  task_id uuid NOT NULL REFERENCES tasks(id),
  step_id uuid NOT NULL REFERENCES steps(id),
  request_hash text NOT NULL,
  provider_id text NOT NULL,
  provider_hash text NOT NULL,
  documents jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(step_id,request_hash)
);
CREATE INDEX context_snapshots_task ON context_snapshots(task_id);
