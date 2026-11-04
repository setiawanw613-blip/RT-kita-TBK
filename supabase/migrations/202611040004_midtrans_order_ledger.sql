-- Preserve immutable Midtrans order-to-iuran mappings. A late settlement
-- notification must still be reconcilable after an expired order is replaced.
create table if not exists public.iuran_midtrans_orders (
  order_id text primary key,
  keluarga_id text not null,
  warga_id text not null,
  row_ids integer[] not null,
  total_amount integer not null check (total_amount > 0),
  created_at timestamptz not null default now(),
  constraint iuran_midtrans_orders_order_id_format
    check (order_id ~ '^RTTBK-(PROD|SBX)-[0-9]+-[a-f0-9]{8}$'),
  constraint iuran_midtrans_orders_row_ids_nonempty
    check (cardinality(row_ids) between 1 and 12)
);

alter table public.iuran_midtrans_orders enable row level security;
revoke all on table public.iuran_midtrans_orders from public;
revoke all on table public.iuran_midtrans_orders from anon;
revoke all on table public.iuran_midtrans_orders from authenticated;
grant select, insert, update on table public.iuran_midtrans_orders to service_role;

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
  v_row_ids integer[];
  v_total integer;
begin
  if nullif(btrim(p_warga_id), '') is null
     or nullif(btrim(p_keluarga_id), '') is null
     or p_order_id is null
     or p_order_id !~ '^RTTBK-(PROD|SBX)-[0-9]+-[a-f0-9]{8}$'
     or p_bulans is null
     or cardinality(p_bulans) < 1
     or cardinality(p_bulans) > 12
     or cardinality(p_bulans) <> (
       select count(distinct bulan) from unnest(p_bulans) as u(bulan)
     )
     or exists (
       select 1 from unnest(p_bulans) as u(bulan)
       where bulan is null
          or extract(day from bulan) <> 1
          or bulan < date '2026-10-01'
     ) then
    raise exception 'BATCH_QRIS_TIDAK_VALID' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('qris-iuran:' || p_keluarga_id, 0)
  );

  if not exists (
    select 1
    from public.warga
    where id::text = p_warga_id
      and keluarga_id::text = p_keluarga_id
  ) then
    raise exception 'WARGA_TIDAK_TERDAFTAR_DI_KELUARGA' using errcode = '22023';
  end if;

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

  if cardinality(coalesce(p_replace_ids, array[]::integer[])) <> (
    select count(*)
    from public.iuran_warga
    where id = any(coalesce(p_replace_ids, array[]::integer[]))
      and keluarga_id = p_keluarga_id
      and bulan = any(p_bulans)
      and coalesce(bukti_transfer, '') like 'MIDTRANS:%'
      and status <> 'lunas'
  ) then
    raise exception 'CATATAN_IURAN_PENGGANTI_TIDAK_VALID' using errcode = '22023';
  end if;

  -- Backfill immutable mappings for legacy orders before changing their
  -- current iuran_warga markers. Include every row still attached to each
  -- replaced order, not only the selected subset.
  insert into public.iuran_midtrans_orders (
    order_id, keluarga_id, warga_id, row_ids, total_amount
  )
  select
    split_part(source.bukti_transfer, ':', 2),
    source.keluarga_id,
    min(source.warga_id),
    array_agg(source.id order by source.bulan),
    sum(source.total_amount)::integer
  from public.iuran_warga as source
  where source.bukti_transfer in (
    select distinct replaced.bukti_transfer
    from public.iuran_warga as replaced
    where replaced.id = any(coalesce(p_replace_ids, array[]::integer[]))
  )
  group by source.bukti_transfer, source.keluarga_id
  on conflict (order_id) do nothing;

  update public.iuran_warga
  set status = 'menunggu_verifikasi',
      total_amount = 35000,
      bukti_transfer = 'MIDTRANS:' || p_order_id,
      midtrans_transaction_id = null,
      midtrans_status = 'pending'
  where id = any(coalesce(p_replace_ids, array[]::integer[]))
    and keluarga_id = p_keluarga_id
    and bulan = any(p_bulans);

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

  select
    array_agg(id order by bulan),
    sum(total_amount)::integer
  into v_row_ids, v_total
  from public.iuran_warga
  where keluarga_id = p_keluarga_id
    and bulan = any(p_bulans);

  if cardinality(coalesce(v_row_ids, array[]::integer[])) <> cardinality(p_bulans)
     or v_total <> cardinality(p_bulans) * 35000 then
    raise exception 'RESERVASI_QRIS_TIDAK_LENGKAP' using errcode = 'P0001';
  end if;

  insert into public.iuran_midtrans_orders (
    order_id, keluarga_id, warga_id, row_ids, total_amount
  )
  values (p_order_id, p_keluarga_id, p_warga_id, v_row_ids, v_total);

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
