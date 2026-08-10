DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'crawler'
      AND 'client_connection_check_interval=5s' = ANY(COALESCE(rolconfig, ARRAY[]::text[]))
  ) THEN
    RAISE EXCEPTION 'crawler client_connection_check_interval must be 5s';
  END IF;
END
$$;

SELECT 'crawler runtime settings verified' AS result;
