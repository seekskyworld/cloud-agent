-- 业务显式选择收集失败结果后，才可进入自身补偿流程；默认仍使父任务失败。
ALTER TABLE task_groups ADD COLUMN failure_policy text NOT NULL DEFAULT 'fail' CHECK(failure_policy IN ('fail','collect'));
