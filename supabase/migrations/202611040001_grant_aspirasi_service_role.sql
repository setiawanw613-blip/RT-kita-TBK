-- Grant the Supabase service role the privileges required by RT Kita.
-- Apply in Supabase SQL Editor using a database owner/admin account.
DO $$
DECLARE
  id_sequence text;
BEGIN
  IF to_regclass('public.aspirasi_warga') IS NULL THEN
    RAISE EXCEPTION 'Table public.aspirasi_warga does not exist';
  END IF;

  GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.aspirasi_warga TO service_role;

  id_sequence := pg_get_serial_sequence('public.aspirasi_warga', 'id');
  IF id_sequence IS NOT NULL THEN
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %s TO service_role',
      id_sequence
    );
  END IF;
END
$$;
