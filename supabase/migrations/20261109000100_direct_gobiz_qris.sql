-- Direct GoBiz QRIS integration for RT Kita.
-- Existing Midtrans history is preserved; new GoBiz orders use a separate marker/provider.

ALTER TABLE public.iuran_warga
  ADD COLUMN IF NOT EXISTS gobiz_transaction_id text,
  ADD COLUMN IF NOT EXISTS gobiz_status text,
  ADD COLUMN IF NOT EXISTS gobiz_settlement_at timestamptz,
  ADD COLUMN IF NOT EXISTS gobiz_notification_at timestamptz;

ALTER TABLE public.iuran_midtrans_orders
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'midtrans',
  ADD COLUMN IF NOT EXISTS provider_transaction_id text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_settlement_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.iuran_midtrans_orders'::regclass
      AND conname = 'iuran_midtrans_orders_provider_check'
  ) THEN
    ALTER TABLE public.iuran_midtrans_orders
      ADD CONSTRAINT iuran_midtrans_orders_provider_check
      CHECK (provider IN ('midtrans', 'gobiz'));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_gobiz_iuran_batch(
  p_warga_id text,
  p_keluarga_id text,
  p_bulans date[],
  p_order_id text,
  p_transaction_id text
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
     OR nullif(btrim(p_transaction_id), '') IS NULL
     OR p_bulans IS NULL
     OR cardinality(p_bulans) < 1
     OR cardinality(p_bulans) > 12
     OR cardinality(p_bulans) <> (
       SELECT count(DISTINCT bulan) FROM unnest(p_bulans) AS u(bulan)
     )
     OR EXISTS (
       SELECT 1 FROM unnest(p_bulans) AS u(bulan)
       WHERE bulan IS NULL OR extract(day FROM bulan) <> 1 OR bulan < date '2026-10-01'
     ) THEN
    RAISE EXCEPTION 'BATCH_GOBIZ_TIDAK_VALID' USING ERRCODE = '22023';
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
      jalur_pembayaran, gobiz_transaction_id, gobiz_status
    )
    VALUES (
      p_warga_id, p_keluarga_id, v_bulan, 'menunggu_verifikasi', 35000,
      'GOBIZ:' || p_order_id, 'warga_qris', p_transaction_id, 'pending'
    );
  END LOOP;

  SELECT array_agg(id ORDER BY bulan), sum(total_amount)::integer
    INTO v_row_ids, v_total
  FROM public.iuran_warga
  WHERE keluarga_id = p_keluarga_id AND bulan = ANY(p_bulans);

  IF cardinality(coalesce(v_row_ids, ARRAY[]::integer[])) <> cardinality(p_bulans)
     OR v_total <> cardinality(p_bulans) * 35000 THEN
    RAISE EXCEPTION 'RESERVASI_GOBIZ_TIDAK_LENGKAP' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.iuran_midtrans_orders (
    order_id, keluarga_id, warga_id, row_ids, total_amount,
    provider, provider_transaction_id, provider_status
  )
  VALUES (
    p_order_id, p_keluarga_id, p_warga_id, v_row_ids, v_total,
    'gobiz', p_transaction_id, 'pending'
  );

  RETURN QUERY
  SELECT * FROM public.iuran_warga
  WHERE keluarga_id = p_keluarga_id AND bulan = ANY(p_bulans)
  ORDER BY bulan ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_gobiz_iuran_batch_with_attribution(
  p_warga_id text,
  p_keluarga_id text,
  p_bulans date[],
  p_order_id text,
  p_transaction_id text,
  p_disetorkan_oleh_id bigint,
  p_disetorkan_oleh_nama text
)
RETURNS SETOF public.iuran_warga
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_ids integer[];
BEGIN
  IF p_disetorkan_oleh_id IS NULL
     OR nullif(btrim(p_disetorkan_oleh_nama), '') IS NULL
     OR length(p_disetorkan_oleh_nama) > 120 THEN
    RAISE EXCEPTION 'ATRIBUSI_PENYETOR_TIDAK_VALID' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(r.id ORDER BY r.bulan) INTO v_ids
  FROM public.reserve_gobiz_iuran_batch(
    p_warga_id, p_keluarga_id, p_bulans, p_order_id, p_transaction_id
  ) AS r;

  IF cardinality(coalesce(v_ids, ARRAY[]::integer[])) <> cardinality(p_bulans) THEN
    RAISE EXCEPTION 'RESERVASI_GOBIZ_ATRIBUSI_TIDAK_LENGKAP' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.iuran_warga
  SET jalur_pembayaran = 'ketua_gang_qris',
      disetorkan_oleh_id = p_disetorkan_oleh_id,
      disetorkan_oleh_nama = btrim(p_disetorkan_oleh_nama)
  WHERE id = ANY(v_ids);

  UPDATE public.iuran_midtrans_orders
  SET jalur_pembayaran = 'ketua_gang_qris',
      disetorkan_oleh_id = p_disetorkan_oleh_id,
      disetorkan_oleh_nama = btrim(p_disetorkan_oleh_nama)
  WHERE order_id = p_order_id AND provider = 'gobiz';

  RETURN QUERY SELECT * FROM public.iuran_warga
  WHERE id = ANY(v_ids) ORDER BY bulan ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_gobiz_iuran_order_atomic(
  p_order_id text,
  p_gross_amount integer,
  p_transaction_id text,
  p_outlet_id text,
  p_expected_outlet_id text,
  p_settlement_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_order public.iuran_midtrans_orders%ROWTYPE;
  v_iuran public.iuran_warga%ROWTYPE;
  v_id integer;
  v_item record;
  v_keterangan text;
  v_kas public.kas_rt%ROWTYPE;
  v_count integer := 0;
  v_paid_count integer := 0;
BEGIN
  IF p_order_id IS NULL
     OR p_order_id !~ '^RTTBK-(PROD|SBX)-[0-9]+-[a-f0-9]{8}$'
     OR nullif(btrim(p_transaction_id), '') IS NULL
     OR nullif(btrim(p_outlet_id), '') IS NULL
     OR p_expected_outlet_id IS NULL
     OR p_outlet_id IS DISTINCT FROM p_expected_outlet_id
     OR p_gross_amount IS NULL OR p_gross_amount <= 0
     OR p_settlement_at IS NULL THEN
    RAISE EXCEPTION 'NOTIFIKASI_GOBIZ_TIDAK_VALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.iuran_midtrans_orders
  WHERE order_id = p_order_id AND provider = 'gobiz'
  FOR UPDATE;

  IF NOT FOUND OR cardinality(coalesce(v_order.row_ids, ARRAY[]::integer[])) < 1 THEN
    RAISE EXCEPTION 'ORDER_GOBIZ_TIDAK_DITEMUKAN' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.total_amount <> p_gross_amount
     OR v_order.provider_transaction_id IS DISTINCT FROM p_transaction_id THEN
    RAISE EXCEPTION 'NOMINAL_ATAU_TRANSAKSI_GOBIZ_TIDAK_COCOK' USING ERRCODE = '23514';
  END IF;

  FOR v_id IN SELECT unnest(v_order.row_ids) LOOP
    SELECT * INTO v_iuran FROM public.iuran_warga WHERE id = v_id FOR UPDATE;
    IF NOT FOUND
       OR v_iuran.bukti_transfer <> 'GOBIZ:' || p_order_id
       OR v_iuran.keluarga_id <> v_order.keluarga_id
       OR coalesce(v_iuran.total_amount, 0) <> 35000 THEN
      RAISE EXCEPTION 'CATATAN_IURAN_GOBIZ_TIDAK_COCOK' USING ERRCODE = '23514';
    END IF;
    v_count := v_count + 1;
    IF v_iuran.status = 'lunas' THEN
      v_paid_count := v_paid_count + 1;
    END IF;
  END LOOP;

  IF v_count <> cardinality(v_order.row_ids)
     OR v_order.total_amount <> v_count * 35000 THEN
    RAISE EXCEPTION 'TOTAL_IURAN_GOBIZ_TIDAK_COCOK' USING ERRCODE = '23514';
  END IF;

  IF v_paid_count = v_count THEN
    UPDATE public.iuran_midtrans_orders
    SET provider_status = 'settlement',
        provider_settlement_at = coalesce(provider_settlement_at, p_settlement_at)
    WHERE order_id = p_order_id;
    RETURN jsonb_build_object('ok', true, 'already_paid', true, 'updated_rows', 0);
  END IF;

  IF v_paid_count <> 0 THEN
    RAISE EXCEPTION 'STATUS_IURAN_GOBIZ_TIDAK_KONSISTEN' USING ERRCODE = '23514';
  END IF;

  FOR v_id IN SELECT unnest(v_order.row_ids) LOOP
    SELECT * INTO v_iuran FROM public.iuran_warga WHERE id = v_id FOR UPDATE;

    FOR v_item IN
      SELECT * FROM (VALUES
        ('Sampah'::text, 15000::numeric),
        ('Keamanan'::text, 15000::numeric),
        ('Kas RT'::text, 5000::numeric)
      ) AS x(kategori, jumlah)
    LOOP
      v_keterangan := v_item.kategori || ' dari iuran ' ||
        coalesce(v_iuran.bulan::text, '') || ' - iuran_id ' || v_iuran.id::text ||
        CASE
          WHEN v_iuran.jalur_pembayaran = 'ketua_gang_qris'
           AND nullif(v_iuran.disetorkan_oleh_nama, '') IS NOT NULL
          THEN ' - disetorkan oleh ' || v_iuran.disetorkan_oleh_nama
          ELSE ''
        END;

      SELECT * INTO v_kas FROM public.kas_rt
      WHERE keterangan = v_keterangan LIMIT 1 FOR UPDATE;

      IF FOUND THEN
        IF v_kas.jenis <> 'masuk'
           OR coalesce(v_kas.jumlah, 0) <> v_item.jumlah
           OR (v_kas.kategori IS NOT NULL AND v_kas.kategori <> v_item.kategori) THEN
          RAISE EXCEPTION 'CATATAN_KAS_GOBIZ_TIDAK_KONSISTEN' USING ERRCODE = '23514';
        END IF;
        IF v_kas.kategori IS NULL THEN
          UPDATE public.kas_rt SET kategori = v_item.kategori WHERE id = v_kas.id;
        END IF;
      ELSE
        INSERT INTO public.kas_rt (tanggal, jenis, kategori, keterangan, jumlah)
        VALUES (p_settlement_at::date, 'masuk', v_item.kategori, v_keterangan, v_item.jumlah);
      END IF;
    END LOOP;

    UPDATE public.iuran_warga
    SET status = 'lunas',
        dibayar_at = p_settlement_at,
        diverifikasi_at = now(),
        diverifikasi_oleh = 'GoBiz QRIS',
        gobiz_status = 'settlement',
        gobiz_settlement_at = p_settlement_at,
        gobiz_notification_at = now()
    WHERE id = v_id;
  END LOOP;

  UPDATE public.iuran_midtrans_orders
  SET provider_status = 'settlement',
      provider_settlement_at = p_settlement_at
  WHERE order_id = p_order_id AND provider = 'gobiz';

  RETURN jsonb_build_object('ok', true, 'already_paid', false, 'updated_rows', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_gobiz_iuran_batch(text,text,date[],text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_gobiz_iuran_batch_with_attribution(text,text,date[],text,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_gobiz_iuran_order_atomic(text,integer,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_gobiz_iuran_batch(text,text,date[],text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_gobiz_iuran_batch_with_attribution(text,text,date[],text,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_gobiz_iuran_order_atomic(text,integer,text,text,text,timestamptz) TO service_role;

COMMENT ON FUNCTION public.settle_gobiz_iuran_order_atomic(text,integer,text,text,text,timestamptz)
IS 'Idempotent, server-only GoBiz QRIS settlement; verifies outlet, order, total and atomically records all iuran cash entries.';
