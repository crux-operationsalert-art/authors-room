-- 0003_vector.sql — pgvector retrieval index (Supabase; skipped in local tests
-- when the extension is not installed).
create extension if not exists vector;

create table public.block_embeddings (
  block_version_id uuid primary key references public.block_versions(id),
  book_id          uuid not null references public.books(id),
  model_id         text not null,
  dims             int  not null,
  embedding        vector(768) not null,
  created_at       timestamptz not null default now()
);
create index block_embeddings_hnsw on public.block_embeddings
  using hnsw (embedding vector_cosine_ops);

alter table public.block_embeddings enable row level security;
create policy emb_read on public.block_embeddings for select to authenticated using (app.owns_book(book_id));
