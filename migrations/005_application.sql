-- 跨入口会话关联属于任务应用层；邮件保留自己的投递状态。
CREATE TABLE conversation_bindings (
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  namespace text NOT NULL,
  external_key text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  PRIMARY KEY(workspace_id,principal_id,namespace,external_key)
);
INSERT INTO conversation_bindings
SELECT b.workspace_id,m.principal_id,'mail:'||m.mailbox,m.provider_thread,m.conversation_id
FROM mail_threads m JOIN mailboxes b ON b.id=m.mailbox;
ALTER TABLE mail_tasks ADD COLUMN principal_id text;
UPDATE mail_tasks m SET principal_id=t.principal_id FROM tasks t WHERE t.id=m.task_id;
ALTER TABLE mail_tasks ALTER COLUMN principal_id SET NOT NULL;
ALTER TABLE mail_tasks ADD COLUMN checked_at timestamptz NOT NULL DEFAULT 'epoch';
CREATE INDEX mail_tasks_scan ON mail_tasks(mailbox,checked_at);
