-- 业务迁移只由部署账号执行；请求审计不保存正文或供应商凭据。
CREATE TABLE business_migrations (
  package_id text NOT NULL,
  migration_id text NOT NULL,
  checksum text NOT NULL,
  version text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(package_id,migration_id)
);
CREATE TABLE business_requests (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  package_id text NOT NULL,
  route_id text NOT NULL,
  command_key text,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business_jobs (
  id text PRIMARY KEY,
  config_hash text NOT NULL,
  next_at timestamptz NOT NULL DEFAULT now()
);
