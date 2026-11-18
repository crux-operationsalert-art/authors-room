-- 0001_core.sql — Author's Room core: authors, books, manuscript blocks and
-- immutable versions, approvals, snapshots, audit log.
-- Integrity rules (Blueprint §5):
--   * block_versions is insert-only
--   * manuscript text changes ONLY through app.commit_block_version()
--   * an author_approved block cannot change without a matching author approval
--   * every book-scoped row is protected by row-level security

create extension if not exists pgcrypto;
create schema if not exists app;

-- ---------------------------------------------------------------- identity
create table public.authors (
  id               uuid primary key default gen_random_uuid(),
  auth_user_id     uuid not null unique,
  display_name     text not null,
  language_variant text not null default 'en-GB',
  created_at       timestamptz not null default now()
);

create table public.books (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references public.authors(id),
  working_title text not null,
  kind          text not null default 'fiction'
                check (kind in ('fiction','non_fiction','children','poetry')),
  status        text not null default 'intake'
                check (status in ('intake','planning','writing','production','released','archived')),
  -- 'confidential' = paid AI tier only (Blueprint §8, D-05)
  privacy_mode  text not null default 'confidential'
                check (privacy_mode in ('confidential','standard')),
  created_at    timestamptz not null default now(),
  archived_at   timestamptz
);

-- ---------------------------------------------------------------- helpers
create or replace function app.current_author_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.authors where auth_user_id = auth.uid()
$$;

create or replace function app.is_author() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.authors where auth_user_id = auth.uid())
$$;

create or replace function app.owns_book(p_book uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.books b
    join public.authors a on a.id = b.author_id
    where b.id = p_book and a.auth_user_id = auth.uid())
$$;

-- ---------------------------------------------------------------- structure
create table public.outline_units (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references public.books(id),
  parent_id   uuid references public.outline_units(id),
  level       text not null check (level in ('part','chapter','scene','argument')),
  order_key   text not null,
  title       text,
  purpose     text,
  status      text not null default 'planned'
              check (status in ('planned','drafting','reviewed','author_approved')),
  created_at  timestamptz not null default now()
);

create table public.manuscript_blocks (
  id                 uuid primary key default gen_random_uuid(),
  book_id            uuid not null references public.books(id),
  unit_id            uuid references public.outline_units(id),
  order_key          text not null,
  kind               text not null default 'paragraph'
                     check (kind in ('paragraph','heading','dialogue','epigraph')),
  current_version_id uuid,
  status             text not null default 'planned'
                     check (status in ('planned','drafted','in_review','revision_requested',
                                       'qc_passed','author_approved','reopened','cut')),
  created_at         timestamptz not null default now()
);

create table public.block_versions (
  id                uuid primary key default gen_random_uuid(),
  block_id          uuid not null references public.manuscript_blocks(id),
  book_id           uuid not null references public.books(id),
  version_no        int  not null,
  text              text not null,
  text_hash         text not null,
  parent_version_id uuid references public.block_versions(id),
  reason            text not null,
  actor_type        text not null check (actor_type in ('author','agent','system')),
  agent_run_id      uuid,
  provenance        text not null
                    check (provenance in ('author_written','ai_generated','ai_edited')),
  created_at        timestamptz not null default now(),
  unique (block_id, version_no)
);

alter table public.manuscript_blocks
  add constraint manuscript_blocks_current_fk
  foreign key (current_version_id) references public.block_versions(id);

-- block_versions is insert-only
create or replace function app.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
    using errcode = 'P0001';
end $$;

create trigger block_versions_append_only
  before update or delete on public.block_versions
  for each row execute function app.forbid_change();

-- current_version_id may only change inside commit_block_version / approve
create or replace function app.guard_block_pointer() returns trigger
language plpgsql as $$
begin
  if new.current_version_id is distinct from old.current_version_id
     and coalesce(current_setting('app.via_commit', true), '') <> 'on' then
    raise exception 'manuscript text can only change through app.commit_block_version()'
      using errcode = 'P0001';
  end if;
  if old.status = 'author_approved' and new.status <> old.status
     and coalesce(current_setting('app.via_commit', true), '') <> 'on' then
    raise exception 'an author-approved block can only be reopened through the workflow'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger manuscript_blocks_guard
  before update on public.manuscript_blocks
  for each row execute function app.guard_block_pointer();

-- ---------------------------------------------------------------- approvals
create table public.approvals (
  id              uuid primary key default gen_random_uuid(),
  book_id         uuid not null references public.books(id),
  subject_type    text not null check (subject_type in
                    ('block','block_change','unit','constitution','outline','edition','change_request')),
  subject_id      uuid not null,
  -- for block_change: md5 of the exact text the author approved
  approved_text_hash text,
  decision        text not null check (decision in ('approved','rejected')),
  author_id       uuid not null references public.authors(id),
  consumed_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table public.manuscript_snapshots (
  id                uuid primary key default gen_random_uuid(),
  book_id           uuid not null references public.books(id),
  label             text not null,
  block_version_ids uuid[] not null,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------- audit log
create table public.audit_log (
  id         bigint generated always as identity primary key,
  book_id    uuid,
  actor      uuid,
  action     text not null,
  table_name text not null,
  row_id     uuid,
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);

create or replace function app.audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb; o jsonb;
begin
  r := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  o := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  insert into public.audit_log(book_id, actor, action, table_name, row_id, before, after)
  values (coalesce((r->>'book_id')::uuid, (o->>'book_id')::uuid),
          auth.uid(), tg_op, tg_table_name,
          coalesce((r->>'id')::uuid, (o->>'id')::uuid), o, r);
  return coalesce(new, old);
end $$;

create trigger audit_blocks    after insert or update or delete on public.manuscript_blocks for each row execute function app.audit();
create trigger audit_versions  after insert on public.block_versions    for each row execute function app.audit();
create trigger audit_approvals after insert or update on public.approvals for each row execute function app.audit();
create trigger audit_books     after insert or update on public.books     for each row execute function app.audit();

-- ---------------------------------------------------------------- write path
-- The ONLY way manuscript text changes. Used by the Lead Writer (service role)
-- and by the author's own edits (provenance author_written).
create or replace function app.commit_block_version(
  p_block_id     uuid,
  p_text         text,
  p_reason       text,
  p_actor_type   text,
  p_provenance   text,
  p_agent_run_id uuid default null,
  p_approval_id  uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  b        public.manuscript_blocks%rowtype;
  v_no     int;
  v_id     uuid;
  v_hash   text := md5(p_text);
  a        public.approvals%rowtype;
  v_status text := 'drafted';
begin
  select * into b from public.manuscript_blocks where id = p_block_id for update;
  if not found then raise exception 'block % not found', p_block_id; end if;
  if b.status = 'cut' then raise exception 'block % is cut; restore it first', p_block_id; end if;

  if b.status = 'author_approved' then
    if p_approval_id is null then
      raise exception 'block % is author-approved; a change needs the author''s approval', p_block_id
        using errcode = 'P0001';
    end if;
    select * into a from public.approvals where id = p_approval_id for update;
    if not found or a.subject_type <> 'block_change' or a.subject_id <> p_block_id
       or a.decision <> 'approved' or a.consumed_at is not null
       or a.approved_text_hash is distinct from v_hash then
      raise exception 'approval % does not authorise this exact change to block %', p_approval_id, p_block_id
        using errcode = 'P0001';
    end if;
    update public.approvals set consumed_at = now() where id = p_approval_id;
    v_status := 'author_approved';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_no
    from public.block_versions where block_id = p_block_id;

  insert into public.block_versions(block_id, book_id, version_no, text, text_hash,
         parent_version_id, reason, actor_type, agent_run_id, provenance)
  values (p_block_id, b.book_id, v_no, p_text, v_hash, b.current_version_id,
          p_reason, p_actor_type, p_agent_run_id, p_provenance)
  returning id into v_id;

  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks
     set current_version_id = v_id, status = v_status
   where id = p_block_id;
  perform set_config('app.via_commit', 'off', true);
  return v_id;
end $$;

-- Workflow status moves that are not text changes (in_review, qc_passed, ...)
create or replace function app.set_block_status(p_block_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status = 'author_approved' then
    raise exception 'use app.approve_block() for author approval';
  end if;
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks set status = p_status where id = p_block_id;
  perform set_config('app.via_commit', 'off', true);
end $$;

-- Author approval of the block's current version. Must be the book's owner.
create or replace function app.approve_block(p_block_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare b public.manuscript_blocks%rowtype; v_author uuid; v_id uuid;
begin
  select * into b from public.manuscript_blocks where id = p_block_id for update;
  if not app.owns_book(b.book_id) then
    raise exception 'only the book''s author can approve' using errcode = '42501';
  end if;
  if b.current_version_id is null then raise exception 'nothing to approve'; end if;
  v_author := app.current_author_id();
  insert into public.approvals(book_id, subject_type, subject_id, decision, author_id)
  values (b.book_id, 'block', p_block_id, 'approved', v_author) returning id into v_id;
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks set status = 'author_approved' where id = p_block_id;
  perform set_config('app.via_commit', 'off', true);
  return v_id;
end $$;

-- Author authorises one exact replacement text for an approved block.
create or replace function app.authorise_block_change(p_block_id uuid, p_new_text text)
returns uuid language plpgsql security definer set search_path = public as $$
declare b public.manuscript_blocks%rowtype; v_id uuid;
begin
  select * into b from public.manuscript_blocks where id = p_block_id;
  if not app.owns_book(b.book_id) then
    raise exception 'only the book''s author can authorise changes' using errcode = '42501';
  end if;
  insert into public.approvals(book_id, subject_type, subject_id, approved_text_hash, decision, author_id)
  values (b.book_id, 'block_change', p_block_id, md5(p_new_text), 'approved', app.current_author_id())
  returning id into v_id;
  return v_id;
end $$;

-- Rollback = a new version whose text equals an older one (history kept).
create or replace function app.rollback_block(p_block_id uuid, p_to_version int, p_approval_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not app.owns_book((select book_id from public.manuscript_blocks where id = p_block_id)) then
    raise exception 'only the book''s author can roll back' using errcode = '42501';
  end if;
  select text into t from public.block_versions where block_id = p_block_id and version_no = p_to_version;
  if t is null then raise exception 'version % not found', p_to_version; end if;
  return app.commit_block_version(p_block_id, t, 'rollback to v' || p_to_version,
                                  'author', 'author_written', null, p_approval_id);
end $$;

-- ---------------------------------------------------------------- RLS
alter table public.authors              enable row level security;
alter table public.books                enable row level security;
alter table public.outline_units        enable row level security;
alter table public.manuscript_blocks    enable row level security;
alter table public.block_versions       enable row level security;
alter table public.approvals            enable row level security;
alter table public.manuscript_snapshots enable row level security;
alter table public.audit_log            enable row level security;

create policy authors_self   on public.authors   for select to authenticated using (auth_user_id = auth.uid());
create policy books_owner   on public.books     for all    to authenticated using (app.owns_book(id)) with check (author_id = app.current_author_id());
create policy units_owner   on public.outline_units        for all    to authenticated using (app.owns_book(book_id)) with check (app.owns_book(book_id));
create policy blocks_read   on public.manuscript_blocks    for select to authenticated using (app.owns_book(book_id));
create policy versions_read on public.block_versions       for select to authenticated using (app.owns_book(book_id));
create policy approvals_read on public.approvals           for select to authenticated using (app.owns_book(book_id));
create policy snaps_owner   on public.manuscript_snapshots for all    to authenticated using (app.owns_book(book_id)) with check (app.owns_book(book_id));
create policy audit_read    on public.audit_log            for select to authenticated using (app.owns_book(book_id));
-- No insert/update policies on blocks, versions or approvals for authenticated:
-- those writes go only through the security-definer functions above.

revoke all on function app.commit_block_version(uuid,text,text,text,text,uuid,uuid) from public;
revoke all on function app.set_block_status(uuid,text) from public;
grant execute on function app.commit_block_version(uuid,text,text,text,text,uuid,uuid) to service_role;
grant execute on function app.set_block_status(uuid,text) to service_role;
grant execute on function app.approve_block(uuid), app.authorise_block_change(uuid,text),
                          app.rollback_block(uuid,int,uuid) to authenticated;
grant usage on schema app to authenticated, service_role;
