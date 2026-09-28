-- 人工核实记录不可变；命令键在任务内唯一，防止重复推进未知写入。
CREATE TABLE task_reconciliations (
  task_id uuid NOT NULL REFERENCES tasks(id),
  command_key text NOT NULL,
  request_hash text NOT NULL,
  principal_id text NOT NULL,
  step_id uuid NOT NULL REFERENCES steps(id),
  decision text NOT NULL CHECK (decision IN ('succeeded','cancelled')),
  reason text NOT NULL,
  receipt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,command_key)
);
