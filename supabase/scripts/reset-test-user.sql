-- Removes the end-to-end test user (e2e-test@authors-room.test) and every book it created.
-- Usage records in agent_runs are kept (book and job links set to null).
begin;
set local session_replication_role = replica;
create temp table tb on commit drop as select b.id from books b join authors a on a.id = b.author_id
  where a.auth_user_id = '00000000-0000-0000-0000-0000000e2e01';
update agent_runs set book_id = null, job_id = null where book_id in (select id from tb)
  or job_id in (select id from agent_jobs where book_id in (select id from tb));
delete from editorial_issues where book_id in (select id from tb);
delete from review_runs where book_id in (select id from tb);
delete from canon_facts where book_id in (select id from tb);
delete from entities where book_id in (select id from tb);
delete from author_voice_profiles where book_id in (select id from tb);
delete from decisions where book_id in (select id from tb);
delete from intake_messages where book_id in (select id from tb);
delete from agent_jobs where book_id in (select id from tb);
delete from approvals where book_id in (select id from tb);
delete from block_embeddings where book_id in (select id from tb);
delete from manuscript_snapshots where book_id in (select id from tb);
delete from audit_log where book_id in (select id from tb);
update manuscript_blocks set current_version_id = null where book_id in (select id from tb);
delete from block_versions where book_id in (select id from tb);
delete from manuscript_blocks where book_id in (select id from tb);
delete from outline_units where book_id in (select id from tb);
delete from book_constitutions where book_id in (select id from tb);
delete from books where id in (select id from tb);
delete from authors where auth_user_id = '00000000-0000-0000-0000-0000000e2e01';
delete from auth.identities where user_id = '00000000-0000-0000-0000-0000000e2e01';
delete from auth.users where id = '00000000-0000-0000-0000-0000000e2e01';
commit;
