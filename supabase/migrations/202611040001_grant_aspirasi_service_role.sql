-- Harden RT Kita database without exposing resident or finance tables to direct client access.
-- The application accesses these tables through the server-side service role.

DO $$
DECLARE
  id_sequence text;
  primary_key_exists boolean;
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

  IF to_regclass('public.iuran_warga') IS NULL THEN
    RAISE EXCEPTION 'Table public.iuran_warga does not exist';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.iuran_warga'::regclass
      AND contype = 'p'
  ) INTO primary_key_exists;

  IF NOT primary_key_exists THEN
    IF EXISTS (
      SELECT id
      FROM public.iuran_warga
      GROUP BY id
      HAVING id IS NULL OR count(*) > 1
    ) OR EXISTS (
      SELECT 1 FROM public.iuran_warga WHERE id IS NULL
    ) THEN
      RAISE EXCEPTION 'Cannot add iuran_warga primary key: id contains NULL or duplicate values';
    END IF;

    ALTER TABLE public.iuran_warga
      ADD CONSTRAINT iuran_warga_pkey PRIMARY KEY (id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS pengajuan_surat_warga_id_idx
  ON public.pengajuan_surat (warga_id);

CREATE INDEX IF NOT EXISTS warga_keluarga_id_idx
  ON public.warga (keluarga_id);

-- Keep the DDL event trigger active, but prevent it being called as a public RPC.
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
