-- Atomic settlement for manual iuran verification.
-- Called only by the trusted application server using service_role.

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
  v_kas public.kas_rt%ROWTYPE;
BEGIN
  IF p_iuran_id IS NULL OR p_iuran_id <= 0 THEN
    RAISE EXCEPTION 'ID iuran tidak valid' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(coalesce(p_diverifikasi_oleh, ''))) = 0 THEN
    RAISE EXCEPTION 'Identitas petugas wajib diisi' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_iuran
    FROM public.iuran_warga
   WHERE id = p_iuran_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Data iuran tidak ditemukan' USING ERRCODE = 'P0002';
  END IF;

  -- A repeated request returns the already settled row without booking again.
  IF v_iuran.status = 'lunas' THEN
    RETURN NEXT v_iuran;
    RETURN;
  END IF;

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

    SELECT * INTO v_kas
      FROM public.kas_rt
     WHERE keterangan = v_keterangan
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      IF v_kas.jenis <> 'masuk'
         OR coalesce(v_kas.jumlah, 0) <> v_item.jumlah
         OR (v_kas.kategori IS NOT NULL AND v_kas.kategori <> v_item.kategori) THEN
        RAISE EXCEPTION 'Catatan kas untuk iuran ini tidak konsisten: %', v_keterangan
          USING ERRCODE = '23514';
      END IF;
      IF v_kas.kategori IS NULL THEN
        UPDATE public.kas_rt SET kategori = v_item.kategori WHERE id = v_kas.id;
      END IF;
    ELSE
      INSERT INTO public.kas_rt (tanggal, jenis, kategori, keterangan, jumlah)
      VALUES (CURRENT_DATE, 'masuk', v_item.kategori, v_keterangan, v_item.jumlah);
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
IS 'Server-only atomic verification of one Rp35,000 iuran and its three cash ledger entries.';
