-- The language of an interview (decided by the owner on 2026-11-04): it is the language of the job description, chosen in Pathway and
-- sent in the `create` call. It decides the language the AI talks in, the language the candidate is expected to answer in (an answer in
-- another language sets a negative impression, as the English-only rule did before), the texts of the candidate page, the invitation
-- e-mail and the language of the evaluation. Every interview that exists today, and every create call that carries no language, is English.
--
-- Safe to run on a project that already has interviews: the new column has a default, so no row is rewritten by hand. The table keeps
-- its privileges (service_role only), and nothing the browser can reach changes.
--
-- To undo (only while no interview uses another language):
--   alter table public.interviews drop constraint interviews_language_check;
--   alter table public.interviews drop column language;

alter table public.interviews add column if not exists language text not null default 'en';
alter table public.interviews add constraint interviews_language_check check (language in ('en', 'pt', 'es'));
