-- A Bot can carry user-authored identity instructions and a daily budget for
-- proactive inspiration work. An empty instruction field means the host derives
-- the Bot's focus from its conversation and workspace; a null budget means no
-- spend cap.

alter table openlink.bots
  add column if not exists instructions text not null default '',
  add column if not exists inspiration_budget_usd numeric(12, 4);

alter table openlink.bots
  drop constraint if exists bots_instructions_length;

alter table openlink.bots
  add constraint bots_instructions_length
  check (char_length(instructions) <= 4000);

alter table openlink.bots
  drop constraint if exists bots_inspiration_budget_non_negative;

alter table openlink.bots
  add constraint bots_inspiration_budget_non_negative
  check (inspiration_budget_usd is null or inspiration_budget_usd >= 0);

notify pgrst, 'reload schema';
