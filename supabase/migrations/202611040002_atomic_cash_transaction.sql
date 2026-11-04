-- Atomically validate category balance and record a cash transaction.
-- Apply only after the application code is reviewed and approved for deployment.
create or replace function public.record_cash_transaction(
  p_tanggal date,
  p_jenis text,
  p_kategori text,
  p_keterangan text,
  p_jumlah numeric,
  p_bukti_path text default null,
  p_bukti_hash text default null
)
returns public.kas_rt
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saldo numeric := 0;
  v_row public.kas_rt;
begin
  if p_jenis not in ('masuk', 'keluar')
     or p_tanggal is null
     or nullif(btrim(p_kategori), '') is null
     or nullif(btrim(p_keterangan), '') is null
     or p_jumlah is null
     or p_jumlah <= 0 then
    raise exception 'TRANSAKSI_KAS_TIDAK_VALID' using errcode = '22023';
  end if;

  if p_jenis = 'keluar' and (
    p_bukti_path is null
    or p_bukti_path !~ '^[0-9]+-bukti\.(jpg|png|webp)$'
    or p_bukti_hash is null
    or p_bukti_hash !~ '^[a-f0-9]{64}$'
  ) then
    raise exception 'BUKTI_PENGELUARAN_TIDAK_VALID' using errcode = '22023';
  end if;

  -- Serialize all writes for the same category so concurrent withdrawals
  -- cannot both spend the same available balance.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('kas_rt:' || p_kategori, 0)
  );

  select coalesce(sum(
    case when lower(jenis) like '%keluar' then -coalesce(jumlah, 0)
         else coalesce(jumlah, 0)
    end
  ), 0)
  into v_saldo
  from public.kas_rt
  where kategori = p_kategori;

  if p_jenis = 'keluar' and p_jumlah > v_saldo then
    raise exception 'SALDO_KATEGORI_TIDAK_CUKUP' using errcode = 'P0001';
  end if;

  insert into public.kas_rt (
    tanggal, jenis, kategori, keterangan, jumlah, bukti_path, bukti_hash
  )
  values (
    p_tanggal, p_jenis, p_kategori, p_keterangan, p_jumlah,
    case when p_jenis = 'keluar' then p_bukti_path else null end,
    case when p_jenis = 'keluar' then p_bukti_hash else null end
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_cash_transaction(date, text, text, text, numeric, text, text) from public;
revoke all on function public.record_cash_transaction(date, text, text, text, numeric, text, text) from anon;
revoke all on function public.record_cash_transaction(date, text, text, text, numeric, text, text) from authenticated;
grant execute on function public.record_cash_transaction(date, text, text, text, numeric, text, text) to service_role;
