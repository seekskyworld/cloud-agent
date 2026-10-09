-- 账户 ID 不再等同供应商邮箱地址；旧邮箱 ID 原样保留，避免重放历史邮件。
ALTER TABLE mailboxes ADD COLUMN provider text NOT NULL DEFAULT 'agentmail';
ALTER TABLE mailboxes ADD COLUMN remote_id text;
UPDATE mailboxes SET remote_id=id;
ALTER TABLE mailboxes ALTER COLUMN remote_id SET NOT NULL;
ALTER TABLE mailboxes ADD COLUMN address text;
ALTER TABLE mailboxes ADD COLUMN config_hash text;
CREATE TABLE mail_health (
  mailbox text NOT NULL REFERENCES mailboxes(id),
  kind text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  last_success timestamptz,
  error text,
  PRIMARY KEY(mailbox,kind)
);
