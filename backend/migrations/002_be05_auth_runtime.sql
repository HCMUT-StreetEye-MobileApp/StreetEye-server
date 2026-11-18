-- Narrow server capability: no access to Auth tables or application tables.
-- Password provisioning is local-only via npm run db:runtime, never migration SQL.
CREATE ROLE streeteye_backend NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT streeteye_backend TO postgres;

CREATE SCHEMA streeteye_private;
REVOKE ALL ON SCHEMA streeteye_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA streeteye_private TO streeteye_backend;

CREATE FUNCTION streeteye_private.resolve_contributor(p_auth_user_id uuid, p_session_id uuid)
RETURNS TABLE(contributor_id uuid, role text, disabled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- A signed token alone does not prove the session still exists. Revoked,
  -- expired, banned and deleted identities must never provision a contributor.
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u JOIN auth.sessions s ON s.user_id = u.id
    WHERE u.id = p_auth_user_id AND s.id = p_session_id
      AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until <= now())
      AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN RETURN; END IF;

  INSERT INTO public.contributors(auth_user_id) VALUES (p_auth_user_id)
    ON CONFLICT (auth_user_id) DO NOTHING;
  -- Separate statement after the unique-key wait sees the committed winner
  -- under READ COMMITTED. Never reset an existing role or disabled_at.
  RETURN QUERY SELECT c.contributor_id, c.role, c.disabled_at IS NOT NULL
    FROM public.contributors c WHERE c.auth_user_id = p_auth_user_id;
END;
$$;
REVOKE ALL ON FUNCTION streeteye_private.resolve_contributor(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION streeteye_private.resolve_contributor(uuid,uuid) TO streeteye_backend;

-- Supabase may grant new public objects to API roles by default. The private
-- schema/function above deliberately grants nothing to PostgREST/mobile roles.
