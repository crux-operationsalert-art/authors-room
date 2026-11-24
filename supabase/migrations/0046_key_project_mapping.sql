-- 0046 (24 Nov): verified key -> Google project mapping. Each key's project number was read from Google's own
-- reply to a free, rejected Vertex AI countTokens probe (SERVICE_DISABLED names the key's project). No AI allowance used.
-- Finding: K01, K02, K12 are in the main project 206007276228; the other 18 keys are each in a separate project.
-- Extra free projects are recorded but NOT made routing-eligible (Google's terms forbid getting around usage limits).
alter table public.ai_keys drop constraint if exists ai_keys_ownership_check;
alter table public.ai_keys add constraint ai_keys_ownership_check check (ownership = any (array['unverified', 'manual', 'verified_oauth', 'verified_google_reply']));
alter table public.ai_projects drop constraint if exists ai_projects_discovery_source_check;
alter table public.ai_projects add constraint ai_projects_discovery_source_check check (discovery_source = any (array['manual', 'oauth', 'provisioned', 'google_reply']));

update public.ai_projects set project_number = '206007276228', verified_at = now(), discovery_source = 'google_reply'
 where id = '4c1e582f-535b-4935-ad71-d5e1cdd5d623';

with m(label, num) as (values
  ('K01','206007276228'),('K02','206007276228'),('K03','836217860142'),('K04','466815239766'),('K05','748836535592'),
  ('K06','50818817023'),('K07','648845577143'),('K08','394615747443'),('K09','376271652069'),('K10','711869720476'),
  ('K11','219011486119'),('K12','206007276228'),('K13','404037711250'),('K14','648018885876'),('K15','312026777941'),
  ('K16','725310258591'),('K17','794754386343'),('K18','569812840301'),('K19','539421688648'),('K20','213713695096'),
  ('K21','794048768019')),
ins as (
  insert into public.ai_projects(label, project_number, provider, usage_tier, is_active, routing_eligible, eligibility_reason, discovery_source, verified_at, billing_enabled)
  select distinct 'Project ' || num, num, 'gemini', 'free', false, false,
         'extra free project: listed, not used to add quota (Google terms)', 'google_reply', now(), null
    from m where num <> '206007276228'
      and not exists (select 1 from public.ai_projects p where p.project_number = m.num)
  returning id, project_number)
update public.ai_keys k set
  project_id = coalesce((select id from ins where ins.project_number = m.num),
                        (select id from public.ai_projects p where p.project_number = m.num limit 1)),
  project_confirmed = true, ownership = 'verified_google_reply', last_verified_at = now()
from m where k.label = m.label;

insert into public.provisioning_log(operation, target, status, detail)
values ('discover_keys', '21 Gemini keys', 'ok', 'Project of each key read from Google replies: K01, K02, K12 in main project 206007276228; 18 keys each in their own separate project (listed, not used for quota).');
