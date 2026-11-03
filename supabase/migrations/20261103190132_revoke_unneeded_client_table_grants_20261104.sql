-- The application accesses Supabase through the server-side service_role key only.
-- Browser clients must not receive direct table privileges; RLS remains enabled.
REVOKE ALL PRIVILEGES ON TABLE
  public.aspirasi_warga,
  public.iuran_warga,
  public.kas_rt,
  public.keluarga,
  public.notifikasi,
  public.pengajuan_surat,
  public.pengumuman,
  public.warga
FROM anon, authenticated;
