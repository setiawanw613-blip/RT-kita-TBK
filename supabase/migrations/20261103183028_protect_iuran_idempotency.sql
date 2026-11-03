-- Prevent duplicate household/month iuran rows.
-- Existing production data was checked before applying this migration.
create unique index if not exists iuran_warga_keluarga_bulan_uidx
  on public.iuran_warga (keluarga_id, bulan)
  where keluarga_id is not null and bulan is not null;

-- Prevent duplicate kas entries created from the same iuran record.
-- The predicate applies only to the application's generated iuran ledger rows.
create unique index if not exists kas_rt_iuran_keterangan_uidx
  on public.kas_rt (keterangan)
  where keterangan is not null
    and keterangan like '% - iuran_id %';
