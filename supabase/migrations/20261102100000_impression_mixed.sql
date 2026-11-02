-- Third impression level: "mixed" (owner decision, 2026-11-02).
-- positive = concrete answers, no important weakness; mixed = some good, some clearly weak; negative = little or no
-- job-relevant substance. Old rows keep their value. Only the allowed values of the column change.
alter table public.interviews drop constraint if exists interviews_impression_check;
alter table public.interviews
  add constraint interviews_impression_check check (impression in ('positive', 'mixed', 'negative'));
