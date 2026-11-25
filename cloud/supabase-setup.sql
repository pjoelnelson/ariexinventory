-- =====================================================================================
--  Barcode Inventory (cloud version) - Supabase database setup
--  Paste ALL of this into Supabase -> SQL Editor -> New query, then click "Run".
--  Safe to run again: it updates functions/policies without deleting your data.
-- =====================================================================================

-- ---------------------------------------------------------------- tables
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null default 'pending'
             check (role in ('pending', 'viewer', 'operator', 'admin', 'disabled')),
  created_at timestamptz not null default now()
);

create table if not exists public.items (
  id           bigint generated always as identity primary key,
  barcode      text unique,
  name         text not null check (length(trim(name)) > 0),
  description  text not null default '',
  location     text not null default '',
  quantity     integer not null default 0 check (quantity >= 0),   -- stock can never go negative
  min_quantity integer not null default 0 check (min_quantity >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.transactions (
  id            bigint generated always as identity primary key,
  item_id       bigint references public.items(id) on delete set null,
  barcode       text not null,
  item_name     text not null,
  direction     text not null check (direction in ('IN', 'OUT', 'ADJUST')),
  qty           integer not null,
  balance_after integer not null,
  note          text not null default '',
  user_id       uuid,
  username      text not null,
  created_at    timestamptz not null default now()
);
create index if not exists tx_created on public.transactions (created_at desc);
create index if not exists tx_item    on public.transactions (item_id);

-- ---------------------------------------------------------------- role helpers
create or replace function public.role_rank(r text) returns int
language sql immutable as $$
  select case r when 'admin' then 3 when 'operator' then 2 when 'viewer' then 1 else 0 end
$$;

create or replace function public.has_role(min_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public.role_rank(role) from public.profiles where id = auth.uid()), 0)
         >= public.role_rank(min_role)
$$;

-- ---------------------------------------------------------------- new sign-ups
-- The very first account becomes admin. Everyone after that waits as 'pending'
-- until an admin gives them a role, so a stranger who finds the site gets no access.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, coalesce(new.email, ''),
          case when exists (select 1 from public.profiles where role = 'admin') then 'pending' else 'admin' end);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- items: tidy + auto barcode
create or replace function public.items_before_write() returns trigger
language plpgsql as $$
begin
  new.name := trim(new.name);
  new.barcode := nullif(trim(coalesce(new.barcode, '')), '');
  if new.barcode is null then
    new.barcode := 'INV-' || lpad(new.id::text, 6, '0');   -- e.g. INV-000012
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists items_before_write on public.items;
create trigger items_before_write
  before insert or update on public.items for each row execute function public.items_before_write();

-- ---------------------------------------------------------------- row level security
alter table public.profiles     enable row level security;
alter table public.items        enable row level security;
alter table public.transactions enable row level security;

-- Explicit access grants. These make the script work whether or not "Grant API access to new
-- tables automatically" was ticked when the project was created. The policies below then decide
-- which rows each signed-in person may actually see or change.
grant usage on schema public to anon, authenticated;
revoke all on public.profiles, public.items, public.transactions from anon;
grant select on public.profiles, public.items, public.transactions to authenticated;
grant delete on public.items to authenticated;
grant usage on all sequences in schema public to authenticated;

drop policy if exists "read own profile, admins read all" on public.profiles;
create policy "read own profile, admins read all" on public.profiles
  for select to authenticated using (id = auth.uid() or public.has_role('admin'));
revoke insert, update, delete on public.profiles from authenticated;   -- roles change only via set_user_role()

drop policy if exists "members read items" on public.items;
create policy "members read items" on public.items
  for select to authenticated using (public.has_role('viewer'));
drop policy if exists "operators add items" on public.items;
create policy "operators add items" on public.items
  for insert to authenticated with check (public.has_role('operator'));
drop policy if exists "operators edit items" on public.items;
create policy "operators edit items" on public.items
  for update to authenticated using (public.has_role('operator')) with check (public.has_role('operator'));
drop policy if exists "admins delete items" on public.items;
create policy "admins delete items" on public.items
  for delete to authenticated using (public.has_role('admin'));
-- Stock quantity can only change through scan_item() / adjust_stock(), which also write history.
revoke insert, update on public.items from authenticated;
grant insert (barcode, name, description, location, min_quantity) on public.items to authenticated;
grant update (barcode, name, description, location, min_quantity) on public.items to authenticated;

drop policy if exists "members read history" on public.transactions;
create policy "members read history" on public.transactions
  for select to authenticated using (public.has_role('viewer'));
revoke insert, update, delete on public.transactions from authenticated;   -- history can't be edited

-- ---------------------------------------------------------------- scan in / out
create or replace function public.scan_item(p_barcode text, p_direction text, p_qty integer default 1, p_note text default '')
returns json language plpgsql security definer set search_path = public as $$
declare
  me  public.profiles;
  it  public.items;
  tx  public.transactions;
  bal integer;
begin
  select * into me from public.profiles where id = auth.uid();
  if not found or public.role_rank(me.role) < 2 then raise exception 'Your account is not allowed to scan'; end if;
  if p_direction not in ('IN', 'OUT') then raise exception 'Direction must be IN or OUT'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 1000000 then raise exception 'Quantity must be between 1 and 1,000,000'; end if;

  select * into it from public.items where barcode = trim(p_barcode) for update;
  if not found then
    return json_build_object('unknown', true, 'barcode', trim(p_barcode));
  end if;
  if p_direction = 'OUT' and it.quantity < p_qty then
    raise exception 'Only % of "%" in stock - cannot check out %', it.quantity, it.name, p_qty;
  end if;

  bal := it.quantity + case when p_direction = 'IN' then p_qty else -p_qty end;
  update public.items set quantity = bal where id = it.id returning * into it;
  insert into public.transactions (item_id, barcode, item_name, direction, qty, balance_after, note, user_id, username)
  values (it.id, it.barcode, it.name, p_direction, p_qty, bal, left(coalesce(p_note, ''), 500), me.id, me.email)
  returning * into tx;
  return json_build_object('item', row_to_json(it), 'transaction', row_to_json(tx));
end $$;

-- ---------------------------------------------------------------- stock count correction (admin)
create or replace function public.adjust_stock(p_item_id bigint, p_quantity integer, p_note text default '')
returns json language plpgsql security definer set search_path = public as $$
declare
  me public.profiles;
  it public.items;
  tx public.transactions;
  old_qty integer;
begin
  select * into me from public.profiles where id = auth.uid();
  if not found or me.role <> 'admin' then raise exception 'Only admins can do stock counts'; end if;
  if p_quantity is null or p_quantity < 0 then raise exception 'Enter a quantity of 0 or more'; end if;
  select * into it from public.items where id = p_item_id for update;
  if not found then raise exception 'Item not found'; end if;
  old_qty := it.quantity;
  update public.items set quantity = p_quantity where id = it.id returning * into it;
  insert into public.transactions (item_id, barcode, item_name, direction, qty, balance_after, note, user_id, username)
  values (it.id, it.barcode, it.name, 'ADJUST', p_quantity - old_qty, p_quantity,
          coalesce(nullif(left(coalesce(p_note, ''), 500), ''), 'Stock count correction'), me.id, me.email)
  returning * into tx;
  return json_build_object('item', row_to_json(it), 'transaction', row_to_json(tx));
end $$;

-- ---------------------------------------------------------------- user roles (admin)
create or replace function public.set_user_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only admins can change roles'; end if;
  if p_role not in ('pending', 'viewer', 'operator', 'admin', 'disabled') then raise exception 'Unknown role'; end if;
  if p_user = auth.uid() then raise exception 'You can''t change your own role'; end if;
  if p_role <> 'admin'
     and (select role from public.profiles where id = p_user) = 'admin'
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'You need at least one admin';
  end if;
  update public.profiles set role = p_role where id = p_user;
end $$;

-- ---------------------------------------------------------------- dashboard numbers
create or replace function public.dashboard_stats(p_since timestamptz)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('viewer') then raise exception 'Please sign in'; end if;
  return json_build_object(
    'totals', (select json_build_object(
                 'items', count(*),
                 'units', coalesce(sum(quantity), 0),
                 'low',   count(*) filter (where min_quantity > 0 and quantity <= min_quantity))
               from public.items),
    'today',  (select json_build_object(
                 'ins',  coalesce(sum(qty) filter (where direction = 'IN'), 0),
                 'outs', coalesce(sum(qty) filter (where direction = 'OUT'), 0))
               from public.transactions where created_at >= p_since),
    'lowStock', coalesce((select json_agg(i order by i.quantity - i.min_quantity, i.name)
                          from (select * from public.items
                                where min_quantity > 0 and quantity <= min_quantity limit 50) i), '[]'::json),
    'recent',   coalesce((select json_agg(t order by t.id desc)
                          from (select * from public.transactions order by id desc limit 15) t), '[]'::json)
  );
end $$;

-- ---------------------------------------------------------------- keep-alive (stops the free plan pausing)
-- Called every couple of days by cron-job.org. It touches the database but reveals nothing.
create or replace function public.keep_alive()
returns text language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.items limit 1;
  return 'ok';
end $$;

-- ---------------------------------------------------------------- who may call which function
revoke execute on function public.scan_item(text, text, integer, text)  from public, anon;
revoke execute on function public.adjust_stock(bigint, integer, text)   from public, anon;
revoke execute on function public.set_user_role(uuid, text)             from public, anon;
revoke execute on function public.dashboard_stats(timestamptz)          from public, anon;
grant  execute on function public.scan_item(text, text, integer, text)  to authenticated;
grant  execute on function public.adjust_stock(bigint, integer, text)   to authenticated;
grant  execute on function public.set_user_role(uuid, text)             to authenticated;
grant  execute on function public.dashboard_stats(timestamptz)          to authenticated;
grant  execute on function public.keep_alive()                          to anon, authenticated;
