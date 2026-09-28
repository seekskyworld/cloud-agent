-- 部署修订不可变；任务指向创建时的快照，切换入口不会重写旧任务。
CREATE TABLE deployment_revisions(id text PRIMARY KEY, manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE deployment_activation(scope text PRIMARY KEY, revision_id text NOT NULL REFERENCES deployment_revisions(id), generation integer NOT NULL DEFAULT 1);
CREATE TABLE deployment_audit(id bigserial PRIMARY KEY, previous_revision text, revision_id text NOT NULL, actor text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE tasks ADD COLUMN deployment_revision text REFERENCES deployment_revisions(id);
