-- 0045 (24 Nov, quality): the Lead Writer, the only role that writes manuscript text, now starts from the strongest
-- model chain (deep: gemini-3.8-flash first, then the other 3.x flash models, then the lites), like the Chief Editor.
update public.agent_roles set default_tier = 'deep' where code = 'lead_writer';
