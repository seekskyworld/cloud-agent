-- 共用原有投递状态机；业务邮件仍须关联真实任务和稳定工具调用。
ALTER TABLE mail_outbox ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE mail_outbox ALTER COLUMN notification_key DROP NOT NULL;
ALTER TABLE mail_outbox ALTER COLUMN task_status DROP NOT NULL;
ALTER TABLE mail_outbox ADD COLUMN business_policy text;
ALTER TABLE mail_outbox ADD COLUMN policy_version text;
ALTER TABLE mail_outbox ADD COLUMN command_key text;
ALTER TABLE mail_outbox ADD COLUMN request_hash text;
ALTER TABLE mail_outbox ADD COLUMN actor_id text;
ALTER TABLE mail_outbox ADD COLUMN source_task uuid REFERENCES tasks(id);
ALTER TABLE mail_outbox ADD COLUMN wait_key text;
ALTER TABLE mail_outbox ADD COLUMN purpose text NOT NULL DEFAULT 'reply'
  CHECK(purpose IN ('reply','notification','service-request'));
ALTER TABLE mail_outbox ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_origin CHECK (
  (business_policy IS NULL AND task_id IS NOT NULL AND notification_key IS NOT NULL AND task_status IS NOT NULL)
  OR (business_policy IS NOT NULL AND task_id IS NULL AND policy_version IS NOT NULL AND command_key IS NOT NULL AND request_hash IS NOT NULL AND actor_id IS NOT NULL AND source_task IS NOT NULL)
);
CREATE UNIQUE INDEX mail_outbox_business_key ON mail_outbox(mailbox,business_policy,command_key) WHERE business_policy IS NOT NULL;
CREATE TABLE mail_service_receipts (
  mailbox text NOT NULL REFERENCES mailboxes(id),
  event_key text NOT NULL,
  request_id uuid NOT NULL REFERENCES mail_outbox(id),
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mailbox,event_key)
);

-- 仅新建账户采用配置的首次扫描策略；既有邮箱不重新建立基线。
ALTER TABLE mailboxes ADD COLUMN baseline_complete boolean NOT NULL DEFAULT true;
