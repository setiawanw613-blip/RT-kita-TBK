-- Reserve GoBiz QRIS intent before calling the provider.
-- This closes the gap where GoBiz creates a QR but the app fails before storing
-- the provider transaction ID. The same order_id is then safe to retry with the
-- provider Idempotency-Key.
CREATE OR REPLACE FUNCTION public.reserve_gobiz_iuran_intent(
  p_warga_id text,
  p_keluarga_id text,
  p_bulans date[],
  p_order_id text,
  p_jalur_pembayaran text DEFAULT 'warga_qris',
  p_disetorkan_oleh_id bigint DEFAULT NULL,
  p_disetorkan_oleh_nama text DEFAULT NULL
)
RETURNS SETOF public.iuran_warga
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_bulan date;
  v_row_ids integer[];
  v_total integer;
BEGIN
  IF nullif(btrim(p_warga_id), '') IS NULL
     OR nullif(btrim(p_keluarga_id), '') IS NULL
     OR p_order_id IS NULL
     OR p_order_id !~ '^RTTBK-(PROD|SBX)-[0-9]+-[a-f0-9]{8}$'
     OR p_bulans IS NULL
     OR cardinality(p_bulans) < 1
     OR cardinality(p_bulans) > 12
     OR cardinality(p_bulans) <> (
       SELECT count(DISTINCT bulan) FROM unnest(p_bulans) AS u(bulan)
     )
     OR EXISTS (
       SELECT 1 FROM unnest(p_bulans) AS u(bulan)
       WHERE bulan IS NULL OR extract(day FROM bulan) <> 1 OR bulan < date '2026-10-01'
     )
     OR p_jalur_pembayaran NOT IN ('warga_qris', 'ketua_gang_qris')
     OR (p_jalur_pembayaran = 'ketua_gang_qris'
         AND (p_disetorkan_oleh_id IS NULL
              OR nullif(btrim(p_disetorkan_oleh_nama), '') IS NULL
              OR length(p_disetorkan_oleh_nama) > 120))
     OR (p_jalur_pembayaran = 'warga_qris'
         AND (p_disetorkan_oleh_id IS NOT NULL OR p_disetorkan_oleh_nama IS NOT NULL)) THEN
    RAISE EXCEPTION 'INTENT_GOBIZ_TIDAK_VALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('qris-iuran:' || p_keluarga_id, 0)
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.warga
    WHERE id::text = p_warga_id AND keluarga_id::text = p_keluarga_id
  ) THEN
    RAISE EXCEPTION 'WARGA_TIDAK_TERDAFTAR_DI_KELUARGA' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.iuran_warga
  WHERE keluarga_id = p_keluarga_id AND bulan = ANY(p_bulans)
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.iuran_warga
    WHERE keluarga_id = p_keluarga_id AND bulan = ANY(p_bulans)
  ) THEN
    RAISE EXCEPTION 'IURAN_SUDAH_ADA_ATAU_BELUM_DISELESAIKAN' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_bulan IN ARRAY p_bulans LOOP
    INSERT INTO public.iuran_warga (
      warga_id, keluarga_id, bulan, status, total_amount, bukti_transfer,
      jalur_pembayaran, disetorkan_oleh_id, disetorkan_oleh_nama,
      gobiz_status
    )
    VALUES (
      p_warga_id, p_keluarga_id, v_bulan, 'menunggu_verifikasi', 35000,
      'GOBIZ:' || p_order_id, p_jalur_pembayaran,
      p_disetorkan_oleh_id, nullif(btrim(p_disetorkan_oleh_nama), ''),
      'creating'
    );
  END LOOP;

  SELECT array_agg(id ORDER BY bulan), sum(total_amount)::integer
    INTO v_row_ids, v_total
  FROM public.iuran_warga
  WHERE keluarga_id = p_keluarga_id AND bulan = ANY(p_bulans);

  IF cardinality(coalesce(v_row_ids, ARRAY[]::integer[])) <> cardinality(p_bulans)
     OR v_total <> cardinality(p_bulans) * 35000 THEN
    RAISE EXCEPTION 'INTENT_GOBIZ_TIDAK_LENGKAP' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.iuran_midtrans_orders (
    order_id, keluarga_id, warga_id, row_ids, total_amount,
    jalur_pembayaran, disetorkan_oleh_id, disetorkan_oleh_nama,
    provider, provider_status
  )
  VALUES (
    p_order_id, p_keluarga_id, p_warga_id, v_row_ids, v_total,
    p_jalur_pembayaran, p_disetorkan_oleh_id, nullif(btrim(p_disetorkan_oleh_nama), ''),
    'gobiz', 'creating'
  );

  RETURN QUERY
  SELECT * FROM public.iuran_warga
  WHERE keluarga_id = p_keluarga_id AND bulan = ANY(p_bulans)
  ORDER BY bulan ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_gobiz_iuran_intent(
  p_order_id text,
  p_transaction_id text
)
RETURNS SETOF public.iuran_warga
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_order public.iuran_midtrans_orders%ROWTYPE;
  v_count integer;
BEGIN
  IF p_order_id IS NULL
     OR p_order_id !~ '^RTTBK-(PROD|SBX)-[0-9]+-[a-f0-9]{8}$'
     OR nullif(btrim(p_transaction_id), '') IS NULL THEN
    RAISE EXCEPTION 'REFERENSI_INTENT_GOBIZ_TIDAK_VALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order
  FROM public.iuran_midtrans_orders
  WHERE order_id = p_order_id AND provider = 'gobiz'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_GOBIZ_TIDAK_DITEMUKAN' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.provider_status = 'pending' THEN
    IF v_order.provider_transaction_id IS DISTINCT FROM p_transaction_id THEN
      RAISE EXCEPTION 'TRANSAKSI_INTENT_GOBIZ_TIDAK_COCOK' USING ERRCODE = '23514';
    END IF;
    RETURN QUERY
    SELECT * FROM public.iuran_warga
    WHERE id = ANY(v_order.row_ids)
    ORDER BY bulan ASC;
    RETURN;
  END IF;

  IF v_order.provider_status <> 'creating'
     OR v_order.provider_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'STATUS_INTENT_GOBIZ_TIDAK_VALID' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.iuran_warga
  WHERE id = ANY(v_order.row_ids)
    AND keluarga_id = v_order.keluarga_id
    AND bukti_transfer = 'GOBIZ:' || p_order_id
    AND status = 'menunggu_verifikasi'
    AND gobiz_status = 'creating';

  IF v_count <> cardinality(v_order.row_ids) THEN
    RAISE EXCEPTION 'CATATAN_INTENT_GOBIZ_TIDAK_COCOK' USING ERRCODE = '23514';
  END IF;

  UPDATE public.iuran_midtrans_orders
  SET provider_transaction_id = p_transaction_id,
      provider_status = 'pending'
  WHERE order_id = p_order_id;

  UPDATE public.iuran_warga
  SET gobiz_transaction_id = p_transaction_id,
      gobiz_status = 'pending'
  WHERE id = ANY(v_order.row_ids);

  RETURN QUERY
  SELECT * FROM public.iuran_warga
  WHERE id = ANY(v_order.row_ids)
  ORDER BY bulan ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_gobiz_iuran_intent(text,text,date[],text,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_gobiz_iuran_intent(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_gobiz_iuran_intent(text,text,date[],text,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_gobiz_iuran_intent(text,text) TO service_role;

COMMENT ON FUNCTION public.reserve_gobiz_iuran_intent(text,text,date[],text,text,bigint,text)
IS 'Atomically reserves iuran rows and an immutable GoBiz order before provider API call; prevents orphan QR payments.';
COMMENT ON FUNCTION public.complete_gobiz_iuran_intent(text,text)
IS 'Attaches GoBiz provider transaction ID to a previously reserved intent; idempotent for the same transaction.';
