-- Safe retry for a QRIS transaction that GoBiz has confirmed as expired/cancelled.
-- The old order ledger remains immutable so a late settlement can be detected and reviewed.
CREATE OR REPLACE FUNCTION public.reserve_gobiz_iuran_retry(
  p_old_order_id text,
  p_new_order_id text,
  p_new_transaction_id text
)
RETURNS SETOF public.iuran_warga
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_old public.iuran_midtrans_orders%ROWTYPE;
  v_count integer;
  v_total integer;
BEGIN
  IF p_old_order_id IS NULL
     OR p_old_order_id !~ '^RTTBK-(PROD|SBX)-[0-9]+-[a-f0-9]{8}$'
     OR p_new_order_id IS NULL
     OR p_new_order_id !~ '^RTTBK-(PROD|SBX)-[0-9]+-[a-f0-9]{8}$'
     OR p_old_order_id = p_new_order_id
     OR nullif(btrim(p_new_transaction_id), '') IS NULL THEN
    RAISE EXCEPTION 'REFERENSI_RETRY_GOBIZ_TIDAK_VALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old
  FROM public.iuran_midtrans_orders
  WHERE order_id = p_old_order_id AND provider = 'gobiz'
  FOR UPDATE;

  IF NOT FOUND
     OR lower(coalesce(v_old.provider_status, '')) NOT IN
       ('expire', 'expired', 'cancel', 'cancelled', 'deny', 'denied') THEN
    RAISE EXCEPTION 'ORDER_LAMA_BELUM_TERBUKTI_KEDALUWARSA' USING ERRCODE = '23514';
  END IF;

  IF cardinality(coalesce(v_old.row_ids, ARRAY[]::integer[])) < 1
     OR EXISTS (
       SELECT 1 FROM public.iuran_midtrans_orders
       WHERE order_id = p_new_order_id
     ) THEN
    RAISE EXCEPTION 'LEDGER_RETRY_GOBIZ_TIDAK_VALID' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('qris-iuran:' || v_old.keluarga_id::text, 0)
  );

  PERFORM 1 FROM public.iuran_warga
  WHERE id = ANY(v_old.row_ids)
  FOR UPDATE;

  SELECT count(*), coalesce(sum(total_amount), 0)::integer
    INTO v_count, v_total
  FROM public.iuran_warga
  WHERE id = ANY(v_old.row_ids)
    AND keluarga_id::text = v_old.keluarga_id::text
    AND bukti_transfer = 'GOBIZ:' || p_old_order_id
    AND status <> 'lunas'
    AND coalesce(total_amount, 0) = 35000;

  IF v_count <> cardinality(v_old.row_ids)
     OR v_total <> v_old.total_amount
     OR v_total <> v_count * 35000 THEN
    RAISE EXCEPTION 'IURAN_RETRY_GOBIZ_TIDAK_COCOK' USING ERRCODE = '23514';
  END IF;

  UPDATE public.iuran_warga
  SET bukti_transfer = 'GOBIZ:' || p_new_order_id,
      gobiz_transaction_id = p_new_transaction_id,
      gobiz_status = 'pending',
      gobiz_settlement_at = NULL,
      gobiz_notification_at = NULL
  WHERE id = ANY(v_old.row_ids);

  INSERT INTO public.iuran_midtrans_orders (
    order_id, keluarga_id, warga_id, row_ids, total_amount,
    provider, provider_transaction_id, provider_status,
    jalur_pembayaran, disetorkan_oleh_id, disetorkan_oleh_nama
  )
  VALUES (
    p_new_order_id, v_old.keluarga_id, v_old.warga_id, v_old.row_ids, v_old.total_amount,
    'gobiz', p_new_transaction_id, 'pending',
    v_old.jalur_pembayaran, v_old.disetorkan_oleh_id, v_old.disetorkan_oleh_nama
  );

  RETURN QUERY
  SELECT * FROM public.iuran_warga
  WHERE id = ANY(v_old.row_ids)
  ORDER BY bulan ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_gobiz_iuran_retry(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_gobiz_iuran_retry(text,text,text) TO service_role;

COMMENT ON FUNCTION public.reserve_gobiz_iuran_retry(text,text,text)
IS 'Server-only QRIS retry. Replaces active iuran order mapping only after old GoBiz order is verified expired; preserves old order ledger for late-settlement review.';
