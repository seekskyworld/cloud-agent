-- 模型成功结果先写入可恢复检查点，再提交 Step；租约失效后可安全续接，避免重复计算。
ALTER TABLE steps ADD COLUMN checkpoint_hash text;
ALTER TABLE steps ADD COLUMN checkpoint_elapsed_ms integer;
ALTER TABLE steps ADD COLUMN checkpoint_cost_usd double precision;
CREATE INDEX steps_checkpoint_idx ON steps(task_id,checkpoint_hash) WHERE checkpoint_hash IS NOT NULL;
