-- 同一逻辑存储 ID 不得静默指向新的目录或桶。
CREATE TABLE artifact_stores(id text PRIMARY KEY,identity_hash text NOT NULL);
