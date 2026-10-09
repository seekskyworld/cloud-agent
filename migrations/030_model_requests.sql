-- 调用账本不保存正文或凭据；未知远端工作独立于任务租约存活。
CREATE TABLE model_requests (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  step_id uuid NOT NULL REFERENCES steps(id),
  run_id uuid NOT NULL REFERENCES runs(id),
  lease_token uuid NOT NULL,
  operation_key text NOT NULL,
  engine_id text NOT NULL,
  resource_id text NOT NULL,
  cost_invocation text NOT NULL,
  state text NOT NULL CHECK(state IN ('running','cancelling','unknown','completed','not_started')),
  remote_state text NOT NULL DEFAULT 'unknown',
  deadline_at timestamptz NOT NULL,
  quarantine_until timestamptz NOT NULL,
  cost_usd double precision,
  usage_complete boolean NOT NULL DEFAULT false,
  cost_estimated boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz
);
CREATE INDEX model_requests_resource_idx ON model_requests(resource_id,quarantine_until) WHERE state IN ('running','cancelling','unknown');
CREATE INDEX model_requests_step_idx ON model_requests(step_id);
-- NOTIFY 随取消事务提交；租约 token 绑定执行代次，不传身份或用户正文。
CREATE FUNCTION notify_task_cancellation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.status='cancelled' AND OLD.status<>'cancelled' AND OLD.lease_token IS NOT NULL THEN
    PERFORM pg_notify('cloud_agent_cancel',OLD.lease_token::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_cancellation AFTER UPDATE OF status ON tasks FOR EACH ROW EXECUTE FUNCTION notify_task_cancellation();
