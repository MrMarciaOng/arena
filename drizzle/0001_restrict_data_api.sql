-- Arena accesses these objects through PostgreSQL. Supabase can grant its API roles access by default.
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT 'PUBLIC'
    UNION ALL
    SELECT quote_ident(rolname)
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.agents, public.api_keys, public.arenas,
        public.changes, public.counters, public.events, public.login_failures, public.rate_limits FROM %s',
      grantee
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.events_id_seq, public.login_failures_id_seq FROM %s',
      grantee
    );
  END LOOP;
END $$;
