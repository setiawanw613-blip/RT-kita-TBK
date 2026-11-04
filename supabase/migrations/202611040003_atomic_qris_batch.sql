-- Atomically reserve all selected household dues for one QRIS order.
-- This migration is branch-only until explicitly approved and applied.
create or replace function public.reserve_qris_iuran_batch(
  p_warga_id text,
  p_keluarga_id text,
  p_bulans date[],
  p_replace_ids integer[],
  p_order_id text
)
returns setof public.iuran_warga
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bulan date;
  v_row public.iuran_warga;
begin
  if nullif(btrim(p_warga_id), '') is null
     or nullif(btrim(p_keluarga_id), '') is null
     or p_order_id is null
     or p_order_id !~ '^RTTBK-(PROD|SBX)-[0-9]+-[a-f0-9]{8}$'
     or p_bulans is null
     or cardinality(p_bulans) < 1
     or cardinality(p_bulans) > 12
     or cardinality(p_bulans) <> (
       select count(distinct x) from unnest(p_bulans) as x
     )
     or exists (
       select 1 from unnest(p_bulans) as x
       where x is null
          or extract(day from x) <> 1
          or x < date '2026-10-01'
     ) then
    raise exception 'BATCH_QRIS_TIDAK_VALID' using errcode = '22023';
  end if;

  -- Serialize all batch reservations for the same household.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('qris-iuran:' || p_keluarga_id, 0)
  );

  -- Lock current rows and reject paid rows or pending rows not explicitly
  -- confirmed expired by the application before this RPC was called.
  perform 1
  from public.iuran_warga
  where keluarga_id = p_keluarga_id
    and bulan = any(p_bulans)
  for update;

  if exists (
    select 1
    from public.iuran_warga
    where keluarga_id = p_keluarga_id
      and bulan = any(p_bulans)
      and (
        status = 'lunas'
        or not (id = any(coalesce(p_replace_ids, array[]::integer[])))
      )
  ) then
    raise exception 'IURAN_SUDAH_ADA_ATAU_BELUM_EXPIRED' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.iuran_warga
    where id = any(coalesce(p_replace_ids, array[]::integer[]))
      and (
        keluarga_id <> p_keluarga_id
        or bulan <> all(p_bulans)
        or coalesce(bukti_transfer, '') not like 'MIDTRANS:%'
        or status = 'lunas'
      )
  ) then
    raise exception 'CATATAN_IURAN_PENGGANTI_TIDAK_VALID' using errcode = '22023';
  end if;

  update public.iuran_warga
  set status = 'menunggu_verifikasi',
      total_amount = 35000,
      bukti_transfer = 'MIDTRANS:' || p_order_id,
      midtrans_transaction_id = null,
      midtrans_status = 'pending'
  where id = any(coalesce(p_replace_ids, array[]::integer[]))
    and keluarga_id = p_keluarga_id
    and bulan = any(p_bulans)
  ;

  -- Insert all months not already represented by the verified-expired rows.
  foreach v_bulan in array p_bulans loop
    if not exists (
      select 1 from public.iuran_warga
      where keluarga_id = p_keluarga_id and bulan = v_bulan
    ) then
      insert into public.iuran_warga (
        warga_id, keluarga_id, bulan, status, total_amount,
        bukti_transfer, midtrans_status
      )
      values (
        p_warga_id, p_keluarga_id, v_bulan, 'menunggu_verifikasi',
        35000, 'MIDTRANS:' || p_order_id, 'pending'
      )
      returning * into v_row;
    end if;
  end loop;

  return query
  select *
  from public.iuran_warga
  where keluarga_id = p_keluarga_id
    and bulan = any(p_bulans)
  order by bulan asc;
end;
$$;

revoke all on function public.reserve_qris_iuran_batch(text, text, date[], integer[], text) from public;
revoke all on function public.reserve_qris_iuran_batch(text, text, date[], integer[], text) from anon;
revoke all on function public.reserve_qris_iuran_batch(text, text, date[], integer[], text) from authenticated;
grant execute on function public.reserve_qris_iuran_batch(text, text, date[], integer[], text) to service_role;
