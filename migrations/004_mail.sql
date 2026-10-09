-- 邮件通道记录与业务任务分离；邮箱和身份始终参与唯一约束。
CREATE TABLE mailboxes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  cursor text,
  next_poll timestamptz NOT NULL DEFAULT now(),
  blocked_reason text,
  last_error text,
  last_success timestamptz
);
CREATE TABLE mail_webhooks (
  mailbox text NOT NULL REFERENCES mailboxes(id),
  event_id text NOT NULL,
  message_id text NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mailbox,event_id)
);
CREATE TABLE mail_inbound (
  mailbox text NOT NULL REFERENCES mailboxes(id),
  message_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processed','quarantined','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  error text,
  task_id uuid REFERENCES tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mailbox,message_id)
);
CREATE INDEX mail_inbound_pending ON mail_inbound(mailbox,next_attempt) WHERE state='pending';
CREATE TABLE mail_threads (
  mailbox text NOT NULL REFERENCES mailboxes(id),
  principal_id text NOT NULL,
  provider_thread text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  PRIMARY KEY(mailbox,principal_id,provider_thread)
);
CREATE TABLE mail_tasks (
  task_id uuid PRIMARY KEY REFERENCES tasks(id),
  mailbox text NOT NULL REFERENCES mailboxes(id),
  recipient text NOT NULL,
  reply_to text NOT NULL,
  subject text NOT NULL
);
CREATE TABLE mail_outbox (
  id uuid PRIMARY KEY,
  mailbox text NOT NULL REFERENCES mailboxes(id),
  task_id uuid NOT NULL REFERENCES mail_tasks(task_id),
  notification_key text NOT NULL,
  wait_id uuid REFERENCES waits(id),
  task_status text NOT NULL,
  recipient text NOT NULL,
  reply_to text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('draft','pending','sending','sent','uncertain','failed','cancelled')),
  provider_id text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,notification_key)
);
CREATE INDEX mail_outbox_pending ON mail_outbox(mailbox,created_at) WHERE state IN ('pending','sending');
CREATE UNIQUE INDEX mail_outbox_provider ON mail_outbox(mailbox,provider_id) WHERE provider_id IS NOT NULL;
CREATE TABLE mail_audit (
  id bigserial PRIMARY KEY,
  mailbox text NOT NULL REFERENCES mailboxes(id),
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
