-- Every minute: abandon interviews with no sign of life (90 s) and expire unused invitations.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('witcher-sweep', '* * * * *', $$select public.witcher_sweep()$$);
