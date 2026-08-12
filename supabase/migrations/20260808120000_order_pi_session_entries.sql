-- Preserve Pi's native JSONL append order explicitly. Timestamp ordering is
-- not deterministic when several entries share a millisecond, which can make
-- SessionManager reopen the wrong leaf after a Cloud session is restored.
alter table openlink.chat_session_pi_entries
  add column if not exists entry_order bigint;

with ranked as (
  select ctid,
         row_number() over (
           partition by session_id
           order by entry_timestamp asc, created_at asc, entry_id asc
         ) - 1 as entry_order
  from openlink.chat_session_pi_entries
)
update openlink.chat_session_pi_entries as target
   set entry_order = ranked.entry_order
  from ranked
 where target.ctid = ranked.ctid;

alter table openlink.chat_session_pi_entries
  alter column entry_order set not null;

alter table openlink.chat_session_pi_entries
  drop constraint if exists chat_session_pi_entries_entry_order_check,
  add constraint chat_session_pi_entries_entry_order_check check (entry_order >= 0);

create unique index if not exists chat_session_pi_entries_session_order_uidx
  on openlink.chat_session_pi_entries(session_id, entry_order);

notify pgrst, 'reload schema';
