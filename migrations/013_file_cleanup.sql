-- 对象 IO 不持有数据库事务；短期写入/清理租约避免有效写入被过期清理抢占。
ALTER TABLE file_artifacts ADD COLUMN writing_until timestamptz NOT NULL DEFAULT now()+interval '1 minute';
