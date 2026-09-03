# Linux Project VM prerequisite: QEMU + KVM

OpenLink's VM Project backend boots an independent Linux kernel for every
Project. QEMU supplies the virtual machine process and KVM supplies hardware
acceleration. The Container backend does not require either component.

Run the version-matched diagnosis first:

```bash
sudo openlinkctl doctor --config /etc/openlink/openlink.env
```

The CLI reports one stable diagnosis code:

- `KVM_READY`: QEMU and `/dev/kvm` are usable; continue with VM.
- `QEMU_MISSING`: install the distribution's supported QEMU system package.
- `KVM_MODULES_INACTIVE`: the CPU exposes VT-x/AMD-V; let the CLI load the
  installed `kvm` plus `kvm_intel` or `kvm_amd` modules.
- `KVM_PERMISSION_DENIED`: repair the dedicated OpenLink Agent service
  identity's KVM group/device access, then restart the service.
- `CPU_VIRTUALIZATION_UNAVAILABLE`: enable Intel VT-x or AMD-V/SVM in BIOS or
  UEFI, then fully power-cycle the host if its firmware requires it.
- `NESTED_VIRTUALIZATION_UNAVAILABLE`: enable nested virtualization in the
  cloud/VM provider or keep the same deployment profile and select Container.

To request bounded automatic repair during an interactive start:

```bash
sudo openlinkctl start --on-virtualization-unavailable enable
```

Automatic repair can install QEMU through `apt` or `dnf`, load installed KVM
modules and re-run detection. It cannot change BIOS/UEFI settings or a cloud
provider's nested-virtualization policy.

To keep Standard or Dense while explicitly selecting Docker:

```bash
sudo openlinkctl start \
  --project-runtime container \
  --acknowledge-isolation-downgrade 1
```

This changes only Project isolation. It does not change the deployment profile
or any user/organization entitlement.

