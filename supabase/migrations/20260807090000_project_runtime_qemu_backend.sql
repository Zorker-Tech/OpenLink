-- The remote Linux profile runs the repository-built Podman engine inside a
-- QEMU/KVM Project VM. Keep this backend distinct from the local Podman
-- machine while preserving the one-runtime-per-project invariant.

alter table openlink.project_runtimes
  drop constraint if exists project_runtimes_backend_check;

alter table openlink.project_runtimes
  add constraint project_runtimes_backend_check
  check (backend in ('podman-machine', 'qemu-kvm', 'remote-podman-machine'));
