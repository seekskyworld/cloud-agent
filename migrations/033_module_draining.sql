-- 排空只阻止新任务与重试；已有租约/等待继续推进，不删除业务数据。
CREATE TABLE module_drains (
 module_id text PRIMARY KEY, draining boolean NOT NULL, generation integer NOT NULL DEFAULT 1,
 actor text NOT NULL, reason text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE module_drain_audit (
 id bigserial PRIMARY KEY, module_id text NOT NULL, draining boolean NOT NULL,
 generation integer NOT NULL, actor text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE deployment_audit ADD COLUMN retained_modules jsonb NOT NULL DEFAULT '[]';
