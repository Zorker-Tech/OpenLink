alter table openlink.user_preferences
  add column if not exists thinking_visibility text not null default 'summary';
alter table openlink.user_preferences
  add constraint user_preferences_thinking_visibility_check
  check (thinking_visibility in ('summary', 'hidden'));
