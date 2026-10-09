-- 心跳绑定实际模块/配置能力，避免错误版本 Worker 令 API 假就绪。
ALTER TABLE worker_heartbeats ADD COLUMN modules jsonb NOT NULL DEFAULT '[]';
CREATE INDEX worker_heartbeats_seen_idx ON worker_heartbeats(seen_at);
