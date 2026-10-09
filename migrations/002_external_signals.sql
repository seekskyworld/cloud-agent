-- 回调可先于等待到达；先保存已认证事件，再按任务和业务等待键消费。
CREATE TABLE external_signals (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), wait_key text NOT NULL,
  workspace_id text NOT NULL, principal_id text NOT NULL, event_key text NOT NULL,
  response jsonb NOT NULL, request_hash text NOT NULL, status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,wait_key), UNIQUE(workspace_id,principal_id,event_key)
);
