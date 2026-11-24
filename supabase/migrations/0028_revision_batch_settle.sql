-- A revision batch settles for 15 s before its topmost paragraph is opened (items arrive one call at a time).
-- Body applied on 24 Nov 2026: app.advance_revisions with the added_at settle check; column revision_plan_items.added_at.
alter table public.revision_plan_items add column if not exists added_at timestamptz not null default now();
