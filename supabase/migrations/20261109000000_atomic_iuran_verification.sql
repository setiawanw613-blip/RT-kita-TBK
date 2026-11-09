-- Atomic settlement for manual iuran verification.
-- The application server calls this with its private Supabase service credential.
-- Keep this function SECURITY INVOKER; do not expose it to client roles.

CREATE OR REPLACE FUNCTION public.verifikasi_iuran_atomic(
  p_iuran_id integer,
  p_diverifikasi_oleh text
)
RETURNS SETOF public.iuran_warga
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_iuran public.iuran_warga%ROWTYPE;
  v_item record;
  v_keterangan text;
BEGIN
  IF p_iuran_id IS NULL OR p_iuran_id <= 0 THEN
    RAISE EXCEPTION 'ID iuran tidak valid' USING ERRCODE = '22023';
  END IF;

  IF length(btrim(coalesce(p_diverifikasi_oleh, ''))) = 0 THEN
    RAISE EXCEPTION 'Identitas petugas wajib diisi' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_iuran
    FROM public.iuran_warga
   WHERE id = p_iuran_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Data iuran tidak ditemukan' USING ERRCODE = 'P0002';
  END IF;

  -- Repeated requests are safe: an already-paid row is returned unchanged.
  IF v_iuran.status = 'lunas' THEN
    RETURN NEXT v_iuran;
    RETURN;
  END IF;

  -- Do not allow a forged or outdated amount to be settled as a standard month.
  IF coalesce(v_iuran.total_amount, 0) <> 35000 THEN
    RAISE EXCEPTION 'Nominal iuran tidak sesuai tarif resmi' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN
    SELECT *
      FROM (VALUES
        ('Sampah'::text, 15000::numeric),
        ('Keamanan'::text, 15000::numeric),
        ('Kas RT'::text, 5000::numeric)
      ) AS x(kategori, jumlah)
  LOOP
    v_keterangan :=
      v_item.kategori || ' dari iuran ' ||
      coalesce(v_iuran.bulan::text, '') ||
      ' - iuran_id ' || v_iuran.id::text;

    -- The iuran row lock serializes concurrent verification attempts.
    -- Existing entries are preserved; only missing categories are inserted.
    IF NOT EXISTS (
      SELECT 1
        FROM public.kas_rt k
       WHERE k.keterangan = v_keterangan
         AND k.jenis = 'masuk'
         AND k.jumlah = v_item.jumlah
    ) THEN
      INSERT INTO public.kas_rt (
        tanggal, jenis, kategori, keterangan, jumlah
      ) VALUES (
        CURRENT_DATE, 'masuk', v_item.kategori, v_keterangan, v_item.jumlah
      );
    END IF;
  END LOOP;

  UPDATE public.iuran_warga
     SET status = 'lunas',
         diverifikasi_at = now(),
         diverifikasi_oleh = left(btrim(p_diverifikasi_oleh), 120)
   WHERE id = p_iuran_id
   RETURNING * INTO v_iuran;

  RETURN NEXT v_iuran;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.verifikasi_iuran_atomic(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verifikasi_iuran_atomic(integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verifikasi_iuran_atomic(integer, text) TO service_role;

COMMENT ON FUNCTION public.verifikasi_iuran_atomic(integer, text)
IS 'Atomically verifies one Rp35,000 iuran and books Sampah, Keamanan, and Kas RT once. Server-only.';
