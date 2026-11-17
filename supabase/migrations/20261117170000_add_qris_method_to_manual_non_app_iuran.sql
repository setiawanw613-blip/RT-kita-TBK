ALTER TABLE public.iuran_warga_manual
  ADD COLUMN IF NOT EXISTS metode_pembayaran text NOT NULL DEFAULT 'tunai',
  ADD COLUMN IF NOT EXISTS referensi_merchant text;

ALTER TABLE public.iuran_warga_manual DROP CONSTRAINT IF EXISTS iuran_warga_manual_jalur_pembayaran_check;
ALTER TABLE public.iuran_warga_manual ADD CONSTRAINT iuran_warga_manual_jalur_pembayaran_check
  CHECK (jalur_pembayaran IN ('tunai_door_to_door_manual','qris_static_non_app_manual'));
ALTER TABLE public.iuran_warga_manual DROP CONSTRAINT IF EXISTS iuran_warga_manual_metode_pembayaran_check;
ALTER TABLE public.iuran_warga_manual ADD CONSTRAINT iuran_warga_manual_metode_pembayaran_check
  CHECK (metode_pembayaran IN ('tunai','qris'));

CREATE OR REPLACE FUNCTION public.catat_iuran_manual_atomic(
  p_nama_warga text, p_gang text, p_alamat text, p_bulan date,
  p_petugas_id text, p_petugas_nama text,
  p_metode_pembayaran text DEFAULT 'tunai',
  p_referensi_merchant text DEFAULT NULL
) RETURNS public.iuran_warga_manual
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_manual public.iuran_warga_manual; v_kas_id bigint;
  v_metode text := lower(trim(coalesce(p_metode_pembayaran, 'tunai')));
BEGIN
  IF p_nama_warga IS NULL OR length(trim(p_nama_warga)) < 2 OR length(trim(p_nama_warga)) > 120 THEN
    RAISE EXCEPTION 'Nama warga tidak valid' USING ERRCODE = '22023';
  END IF;
  IF p_bulan IS NULL OR extract(day from p_bulan) <> 1 OR p_bulan < DATE '2026-12-01' THEN
    RAISE EXCEPTION 'Bulan iuran tidak valid' USING ERRCODE = '22023';
  END IF;
  IF p_petugas_nama IS NULL OR length(trim(p_petugas_nama)) = 0 THEN
    RAISE EXCEPTION 'Nama petugas wajib diisi' USING ERRCODE = '22023';
  END IF;
  IF v_metode NOT IN ('tunai','qris') THEN RAISE EXCEPTION 'Metode pembayaran tidak valid' USING ERRCODE = '22023'; END IF;
  IF v_metode = 'qris' AND (p_referensi_merchant IS NULL OR length(trim(p_referensi_merchant)) < 3) THEN
    RAISE EXCEPTION 'Referensi transaksi QRIS wajib diisi' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.iuran_warga_manual
    (nama_warga,gang,alamat,bulan,total_amount,jalur_pembayaran,metode_pembayaran,referensi_merchant,petugas_id,petugas_nama)
  VALUES (trim(p_nama_warga),NULLIF(trim(p_gang),''),NULLIF(trim(p_alamat),''),p_bulan,35000,
    CASE WHEN v_metode='qris' THEN 'qris_static_non_app_manual' ELSE 'tunai_door_to_door_manual' END,
    v_metode,NULLIF(trim(p_referensi_merchant),''),NULLIF(trim(p_petugas_id),''),trim(p_petugas_nama))
  RETURNING * INTO v_manual;
  INSERT INTO public.kas_rt(tanggal,jenis,keterangan,jumlah,kategori)
  VALUES(current_date,'pemasukan','Iuran '||CASE WHEN v_metode='qris' THEN 'QRIS' ELSE 'tunai' END||
    ' warga non-aplikasi: '||trim(p_nama_warga)||' · '||to_char(p_bulan,'YYYY-MM')||
    CASE WHEN v_metode='qris' THEN ' · Ref: '||trim(p_referensi_merchant) ELSE '' END,35000,'Iuran Warga')
  RETURNING id INTO v_kas_id;
  UPDATE public.iuran_warga_manual SET kas_rt_id=v_kas_id WHERE id=v_manual.id RETURNING * INTO v_manual;
  RETURN v_manual;
END; $$;
REVOKE ALL ON FUNCTION public.catat_iuran_manual_atomic(text,text,text,date,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.catat_iuran_manual_atomic(text,text,text,date,text,text,text,text) TO service_role;
