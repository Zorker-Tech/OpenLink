-- Cloud Computers can run Oh My Pi through its native RPC terminal protocol.
-- Project defaults remain local-agent scoped; OMP is selected per Cloud chat.
alter table openlink.chat_sessions
  drop constraint if exists chat_sessions_agent_check;

alter table openlink.chat_sessions
  add constraint chat_sessions_agent_check
  check (agent in ('codex', 'pi', 'omp'));

notify pgrst, 'reload schema';
