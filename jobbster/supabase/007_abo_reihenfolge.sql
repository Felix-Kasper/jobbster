-- Zusage · Abo-Stand robuster (12.11.2026)
-- 1. Nachfrist bei offener Zahlung gilt einmal ab dem ersten Fehlschlag (3 Tage) und wächst nicht mit jedem neuen Versuch von Stripe.
-- 2. Ein Ereignis zu einem alten, beendeten Abo überschreibt kein neueres Abo desselben Nutzers.
create or replace function public.apply_subscription(p_customer text, p_subscription text, p_status text, p_period_end timestamptz, p_cancel boolean, p_user uuid default null)
returns boolean language plpgsql set search_path to '' as $$
declare n integer;
begin
  update public.members m set
    stripe_customer_id = coalesce(m.stripe_customer_id, p_customer),
    stripe_subscription_id = p_subscription,
    sub_status = p_status,
    cancel_at_period_end = coalesce(p_cancel, false),
    trial_used = m.trial_used or p_status = 'trialing',
    plan = case when p_status in ('trialing', 'active', 'past_due') then 'abo' else m.plan end,
    limits = case when p_status in ('trialing', 'active', 'past_due') then null else m.limits end,
    valid_until = case
      when p_status in ('trialing', 'active') then p_period_end
      when p_status = 'past_due' and m.sub_status = 'past_due' and m.stripe_subscription_id = p_subscription then m.valid_until
      when p_status = 'past_due' then least(p_period_end, now() + interval '3 days')
      else least(coalesce(m.valid_until, now()), now()) end
  where ((p_user is not null and m.user_id = p_user)
      or (p_user is null and (m.stripe_customer_id = p_customer or m.stripe_subscription_id = p_subscription)))
    and (m.stripe_subscription_id is null
      or m.stripe_subscription_id = p_subscription
      or p_status in ('trialing', 'active', 'past_due', 'incomplete'));
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.apply_subscription(text, text, text, timestamptz, boolean, uuid) from public, anon, authenticated;
grant execute on function public.apply_subscription(text, text, text, timestamptz, boolean, uuid) to service_role;
