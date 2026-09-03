# macOS Project VM prerequisite: Apple Hypervisor

Apple Hypervisor is built into macOS; it is not a package or service that
OpenLink can install. OpenLink uses the sealed `vfkit` and `gvproxy` helpers on
top of that framework.

Check support with:

```bash
/usr/sbin/sysctl -n kern.hv_support
```

`1` means the VM backend is supported. If it reports `0`, use the Container
backend or move the deployment to a supported physical Mac. A macOS guest may
also lack Apple Hypervisor when its outer virtualization provider does not
expose nested virtualization.

