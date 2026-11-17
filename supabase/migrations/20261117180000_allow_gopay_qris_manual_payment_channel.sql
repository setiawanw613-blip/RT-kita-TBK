ALTER TABLE public.iuran_warga
  DROP CONSTRAINT IF EXISTS iuran_warga_jalur_pembayaran_check;

ALTER TABLE public.iuran_warga
  ADD CONSTRAINT iuran_warga_jalur_pembayaran_check
  CHECK (
    jalur_pembayaran = ANY (
      ARRAY[
        'warga_qris'::text,
        'ketua_gang_qris'::text,
        'tunai_door_to_door'::text,
        'gopay_qris_manual'::text
      ]
    )
  );
