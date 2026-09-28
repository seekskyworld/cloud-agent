-- PostgreSQL 行级 SHARE 锁也要求 UPDATE 权限。固定只读函数允许事务持锁，不能给运行角色控制表写权限。
CREATE FUNCTION runtime_maintenance_enabled() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$ SELECT enabled FROM public.platform_maintenance FOR SHARE $$;
CREATE FUNCTION runtime_deployment_revision() RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$ SELECT revision_id FROM public.deployment_activation WHERE scope='default' FOR SHARE $$;
CREATE FUNCTION runtime_lock_principals(p_workspace text,p_ids text[])
RETURNS TABLE(id text,workspace_id text,capabilities text[],enabled boolean,role text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$ SELECT p.id,p.workspace_id,p.capabilities,p.enabled,p.role FROM public.principals p
WHERE p.workspace_id=p_workspace AND p.id=ANY(p_ids) ORDER BY p.id FOR SHARE $$;
REVOKE ALL ON FUNCTION runtime_maintenance_enabled(),runtime_deployment_revision(),runtime_lock_principals(text,text[]) FROM PUBLIC;
