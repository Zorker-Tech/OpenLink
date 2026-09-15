begin;

alter table openlink.project_runtimes
  drop constraint if exists project_runtimes_backend_check;

alter table openlink.project_runtimes
  add constraint project_runtimes_backend_check
  check (backend in ('podman-machine', 'qemu-kvm', 'remote-podman-machine', 'docker-container'));

comment on column openlink.project_runtimes.backend is
  'Observed runtime backend. docker-container is the explicitly selected reduced-isolation host backend; VM and SSH backends remain separately identified.';

commit;
