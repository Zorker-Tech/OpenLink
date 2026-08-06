alter table openlink.chat_sessions
  alter column title set default '新聊天';

update openlink.chat_sessions
set title = case
  when char_length(trim(regexp_replace(initial_prompt, '\\s+', ' ', 'g'))) > 48
    then left(trim(regexp_replace(initial_prompt, '\\s+', ' ', 'g')), 48) || '…'
  when trim(regexp_replace(initial_prompt, '\\s+', ' ', 'g')) <> ''
    then trim(regexp_replace(initial_prompt, '\\s+', ' ', 'g'))
  else '新聊天'
end
where title = 'AI Elements 集成';

create index if not exists chat_sessions_user_workspace_updated_idx
  on openlink.chat_sessions(user_id, workspace_id, updated_at desc);

notify pgrst, 'reload schema';
