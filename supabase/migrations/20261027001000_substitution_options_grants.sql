-- Re-apply the function grants after the return-shape replacement migration.
revoke all on function public.substitution_batch_options(uuid) from public,anon;
grant execute on function public.substitution_batch_options(uuid) to authenticated;
