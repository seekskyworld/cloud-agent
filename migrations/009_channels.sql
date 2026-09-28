-- 通用消息通道使用独立表；历史邮件主键和去重记录不迁写。
CREATE TABLE channel_accounts(id text PRIMARY KEY,workspace_id text NOT NULL,config_hash text NOT NULL);
CREATE TABLE channel_inbound(account text REFERENCES channel_accounts(id),id text NOT NULL,digest text NOT NULL,payload jsonb NOT NULL,state text NOT NULL DEFAULT 'pending',error text,task_id uuid REFERENCES tasks(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account,id));
CREATE TABLE channel_tasks(account text REFERENCES channel_accounts(id),task_id uuid REFERENCES tasks(id),principal_id text NOT NULL,subject text NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account,task_id));
CREATE TABLE channel_outbox(id uuid PRIMARY KEY,account text REFERENCES channel_accounts(id),task_id uuid REFERENCES tasks(id),notice_key text NOT NULL,wait_id uuid,subject text NOT NULL,principal_id text NOT NULL,payload jsonb NOT NULL,state text NOT NULL,error text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(account,task_id,notice_key));
CREATE INDEX channel_pending ON channel_inbound(account,created_at) WHERE state='pending';

CREATE TABLE channel_audit(id bigserial PRIMARY KEY,account text REFERENCES channel_accounts(id),actor text NOT NULL,target uuid NOT NULL,resolution text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
