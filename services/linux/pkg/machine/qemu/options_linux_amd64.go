//go:build linux && amd64

package qemu

var QemuCommand = "qemu-system-x86_64"

func (q *QEMUStubber) addArchOptions(_ *setNewMachineCMDOpts) []string {
	opts := []string{
		"-cpu", "max",
		"-M", "memory-backend=mem,accel=kvm:tcg",
	}
	return opts
}
