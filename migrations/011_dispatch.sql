-- 短事务领取使用共享准入锁；租约代表占用，不维护容易泄漏的内存计数。
CREATE TABLE dispatch_turns(workspace_id text NOT NULL,module_id text NOT NULL,turn bigint NOT NULL,PRIMARY KEY(workspace_id,module_id));
CREATE SEQUENCE dispatch_sequence;
CREATE TABLE connection_rates(id text PRIMARY KEY,window_start timestamptz NOT NULL,count integer NOT NULL);
CREATE INDEX task_admission ON tasks(workspace_id,module_id,lease_until) WHERE status='running';
