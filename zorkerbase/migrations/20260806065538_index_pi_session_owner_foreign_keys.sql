create index if not exists chat_session_pi_sessions_owner_idx
  on openlink.chat_session_pi_sessions(session_id, user_id);

create index if not exists chat_session_pi_entries_owner_idx
  on openlink.chat_session_pi_entries(session_id, user_id);

create index if not exists chat_session_events_owner_idx
  on openlink.chat_session_events(session_id, user_id);
