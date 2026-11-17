CREATE OR REPLACE FUNCTION public.reserve_gopay_static_iuran_batch(
  p_warga_id text,
  p_keluarga_id text,
  p_bulans date[],
  p_order_id text
)
RETURNS SETOF public.iuran_warga
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_count integer;
  v_existing_count integer;
BEGIN
  IF nullif(btrim(p_warga_id), '') IS NULL
     OR nullif(btrim(p_keluarga_id), '') IS NULL
     OR p_order_id IS NULL
     OR p_order_id !~ '^RTTBK-GOPAY-[0-9]{13}-[a-f0-9]{8}$'
     OR p_bulans IS NULL
     OR cardinality(p_bulans) < 1
     OR cardinality(p_bulans) > 12
     OR cardinality(p_bulans) <> (
       SELECT count(DISTINCT bulan) FROM unnest(p_bulans) AS u(bulan)
     )
     OR EXISTS (
       SELECT 1 FROM unnest(p_bulans) AS u(bulan)
       WHERE bulan IS NULL OR extract(day FROM bulan) <> 1 OR bulan < date '2026-12-01'
     ) THEN
    RAISE EXCEPTION 'PENGAJUAN_QRIS_GOPAY_TIDAK_VALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('gopay-static-iuran:' || p_keluarga_id, 0)
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.warga
    WHERE id::text = p_warga_id
      AND keluarga_id::text = p_keluarga_id
      AND lower(coalesce(status_warga, 'aktif')) = 'aktif'
  ) THEN
    RAISE EXCEPTION 'WARGA_TIDAK_AKTIF_ATAU_KELUARGA_TIDAK_COCOK' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_existing_count
  FROM public.iuran_warga
  WHERE keluarga_id = p_keluarga_id
    AND bukti_transfer = 'GOPAY_STATIC:' || p_order_id;

  IF v_existing_count > 0 THEN
    IF v_existing_count <> cardinality(p_bulans)
       OR EXISTS (
         SELECT 1 FROM public.iuran_warga
         WHERE keluarga_id = p_keluarga_id
           AND bukti_transfer = 'GOPAY_STATIC:' || p_order_id
           AND NOT (bulan = ANY(p_bulans))
       )
       OR EXISTS (
         SELECT 1 FROM unnest(p_bulans) AS u(bulan)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.iuran_warga i
           WHERE i.keluarga_id = p_keluarga_id
             AND i.bulan = u.bulan
             AND i.bukti_transfer = 'GOPAY_STATIC:' || p_order_id
         )
       ) THEN
      RAISE EXCEPTION 'ID_PENGAJUAN_QRIS_SUDAH_DIPAKAI' USING ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    SELECT * FROM public.iuran_warga
    WHERE keluarga_id = p_keluarga_id
      AND bukti_transfer = 'GOPAY_STATIC:' || p_order_id
    ORDER BY bulan;
    RETURN;
  END IF;

  PERFORM 1 FROM public.iuran_warga
  WHERE keluarga_id = p_keluarga_id AND bulan = ANY(p_bulans)
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.iuran_warga
    WHERE keluarga_id = p_keluarga_id AND bulan = ANY(p_bulans)
  ) THEN
    RAISE EXCEPTION 'IURAN_SUDAH_ADA_ATAU_MENUNGGU_VERIFIKASI' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.iuran_warga (
    warga_id, keluarga_id, bulan, status, total_amount,
    bukti_transfer, jalur_pembayaran
  )
  SELECT
    p_warga_id, p_keluarga_id, u.bulan, 'menunggu_verifikasi', 35000,
    'GOPAY_STATIC:' || p_order_id, 'gopay_qris_manual'
  FROM unnest(p_bulans) AS u(bulan)
  ORDER BY u.bulan;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> cardinality(p_bulans) THEN
    RAISE EXCEPTION 'PENGAJUAN_QRIS_GOPAY_TIDAK_LENGKAP' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT * FROM public.iuran_warga
  WHERE keluarga_id = p_keluarga_id
    AND bukti_transfer = 'GOPAY_STATIC:' || p_order_id
  ORDER BY bulan;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_gopay_static_iuran_batch(text, text, date[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_gopay_static_iuran_batch(text, text, date[], text) TO service_role;