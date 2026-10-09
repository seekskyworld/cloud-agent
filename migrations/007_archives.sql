-- 热执行轨迹可压缩归档，任务、请求幂等键、等待、回执与审计永久保留。
CREATE TABLE task_archives (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  payload bytea NOT NULL,
  checksum text NOT NULL,
  event_count integer NOT NULL,
  attempt_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_archives_task ON task_archives(task_id,id);
CREATE INDEX tasks_retention ON tasks(updated_at,id) WHERE status IN ('succeeded','failed','cancelled');
CREATE INDEX attempts_step ON invocation_attempts(step_id,id);
