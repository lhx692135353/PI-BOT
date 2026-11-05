ALTER TABLE remote_environments DROP CONSTRAINT IF EXISTS remote_environments_backend_check;
ALTER TABLE remote_environments ADD CONSTRAINT remote_environments_backend_check CHECK (backend IN ('local','ssh','kubevirt'));
