#!/usr/bin/env python3
"""Patch the Golden Disk's EFI GRUB config with a self-contained boot config.

The bootc-installed disk has only 2 partitions (EFI + root XFS) but the
real grub.cfg on XFS does `search --label boot` which loops forever
because no partition has that label.

This v3 patch writes a COMPLETELY self-contained GRUB config that:
  1. Sets root/prefix/boot directly to (hd0,gpt2) — no search commands
  2. Loads grubenv from the XFS partition
  3. Uses `blscfg` to load BLS entries from /boot/loader/entries/
  4. Falls back to a direct kernel load if blscfg finds no entries

The blscfg, loadenv, and XFS modules are all built into the GRUBAA64.EFI
binary (verified by string analysis), so no external .mod files are needed.
"""
import os
import struct
import sys


def patch_grub_cfg(disk_path):
    fd = os.open(disk_path, os.O_RDWR)

    # ── EFI partition geometry (from GPT: LBA 2048, 0.5 GB) ──────────────
    efi_start = 2048 * 512
    os.lseek(fd, efi_start, os.SEEK_SET)
    bs = os.read(fd, 512)

    bytes_per_sector = struct.unpack('<H', bs[11:13])[0]
    sectors_per_cluster = bs[13]
    reserved_sectors = struct.unpack('<H', bs[14:16])[0]
    num_fats = bs[16]
    fat_size32 = struct.unpack('<I', bs[36:40])[0]
    root_cluster = struct.unpack('<I', bs[44:48])[0]

    fat_offset = efi_start + reserved_sectors * bytes_per_sector
    data_offset = fat_offset + num_fats * fat_size32 * bytes_per_sector
    cluster_bytes = sectors_per_cluster * bytes_per_sector

    def read_fat_entry(cluster_num):
        os.lseek(fd, fat_offset + cluster_num * 4, os.SEEK_SET)
        return struct.unpack('<I', os.read(fd, 4))[0]

    def write_fat_entry(cluster_num, value):
        os.lseek(fd, fat_offset + cluster_num * 4, os.SEEK_SET)
        os.write(fd, struct.pack('<I', value))

    def read_cluster(cluster_num):
        os.lseek(fd, data_offset + (cluster_num - 2) * cluster_bytes, os.SEEK_SET)
        return os.read(fd, cluster_bytes)

    def write_cluster(cluster_num, data):
        padded = data.ljust(cluster_bytes, b'\x00')
        os.lseek(fd, data_offset + (cluster_num - 2) * cluster_bytes, os.SEEK_SET)
        os.write(fd, padded)

    def read_cluster_chain(start_cluster, max_size=65536):
        data = b''
        cluster = start_cluster
        while cluster < 0x0FFFFFF8 and cluster >= 2 and len(data) < max_size:
            data += read_cluster(cluster)
            next_cluster = read_fat_entry(cluster)
            if next_cluster == cluster:
                break
            cluster = next_cluster
        return data

    def read_dir_entries(cluster_num):
        data = read_cluster_chain(cluster_num)
        entries = []
        offset = 0
        while offset < len(data):
            entry = data[offset:offset + 32]
            if entry[0] == 0:
                break
            if entry[0] == 0xE5 or entry[11] == 0x0F:
                offset += 32
                continue
            name = entry[:11].decode('ascii', errors='replace')
            attr = entry[11]
            first_cluster = struct.unpack('<H', entry[26:28])[0] | (struct.unpack('<H', entry[20:22])[0] << 16)
            file_size = struct.unpack('<I', entry[28:32])[0]
            entries.append({
                'name': name.strip(),
                'attr': attr,
                'first_cluster': first_cluster,
                'file_size': file_size,
                'dir_offset': offset,
                'raw_name': entry[:11],
            })
            offset += 32
        return entries

    def find_dir_by_path(start_cluster, path_parts):
        cluster = start_cluster
        for part in path_parts:
            entries = read_dir_entries(cluster)
            found = None
            for e in entries:
                if e['attr'] & 0x10 and e['name'].upper().replace(' ', '') == part.upper():
                    found = e
                    break
            if not found:
                return None
            cluster = found['first_cluster']
        return cluster

    # ── Read XFS root UUID ────────────────────────────────────────────────
    # Root partition at LBA 1050624
    root_start = 1050624 * 512
    os.lseek(fd, root_start, os.SEEK_SET)
    xfs_sb = os.read(fd, 512)
    assert struct.unpack('>I', xfs_sb[0:4])[0] == 0x58465342, "Not XFS"
    uuid_bytes = xfs_sb[32:48]
    root_uuid = f"{uuid_bytes[0]:02x}{uuid_bytes[1]:02x}{uuid_bytes[2]:02x}{uuid_bytes[3]:02x}-{uuid_bytes[4]:02x}{uuid_bytes[5]:02x}-{uuid_bytes[6]:02x}{uuid_bytes[7]:02x}-{uuid_bytes[8]:02x}{uuid_bytes[9]:02x}-{uuid_bytes[10]:02x}{uuid_bytes[11]:02x}{uuid_bytes[12]:02x}{uuid_bytes[13]:02x}{uuid_bytes[14]:02x}{uuid_bytes[15]:02x}"
    print(f"Root XFS UUID: {root_uuid}")

    # ── Find EFI/FEDORA/GRUB.CFG ─────────────────────────────────────────
    efi_dir = find_dir_by_path(root_cluster, ['EFI'])
    assert efi_dir is not None, "EFI directory not found"
    fedora_dir = find_dir_by_path(root_cluster, ['EFI', 'FEDORA'])
    assert fedora_dir is not None, "EFI/FEDORA directory not found"

    entries = read_dir_entries(fedora_dir)
    grub_entry = None
    for e in entries:
        if 'GRUB' in e['name'] and 'CFG' in e['name']:
            grub_entry = e
            break
    assert grub_entry is not None, "GRUB.CFG not found in EFI/FEDORA"

    print(f"Found GRUB.CFG: cluster={grub_entry['first_cluster']} size={grub_entry['file_size']}")

    # ── Read original GRUB.CFG ────────────────────────────────────────────
    original = read_cluster_chain(grub_entry['first_cluster'], grub_entry['file_size'])
    print(f"Original GRUB.CFG:\n{original.decode('utf-8', errors='replace')}")

    # ── New GRUB.CFG: self-contained boot config (v3) ────────────────────
    # Completely self-contained: no `configfile` (which loads the looping
    # real grub.cfg from XFS), no `search` commands.  Sets partition refs
    # directly, then uses `blscfg` to load BLS entries from XFS.
    new_cfg = f'''set timeout=5
set default=0
set timeout_style=menu

# Direct partition references — bypass search --label boot loop
set root=(hd0,gpt2)
set prefix=(hd0,gpt2)/boot/grub2
set boot=(hd0,gpt2)

# Load environment block from XFS
if [ -f $prefix/grubenv ]; then
  load_env -f $prefix/grubenv
fi

# Source console config if it exists
if [ -f $prefix/console.cfg ]; then
  source $prefix/console.cfg
fi

# Load BLS entries from /boot/loader/entries/ on XFS
# blscfg module is built into GRUBAA64.EFI
set blsdir=/boot/loader/entries
blscfg

# Fallback: direct kernel load (no ostree= — may not fully boot ostree)
menuentry "Fedora Linux (Direct Boot)" --id direct {{
  set root=(hd0,gpt2)
  linux /boot/vmlinuz-7.1.5-201.fc44.aarch64 root=/dev/vda2 rw
  initrd /boot/initramfs-7.1.5-201.fc44.aarch64.img
}}
'''
    new_data = new_cfg.encode('utf-8')
    print(f"New GRUB.CFG ({len(new_data)} bytes):\n{new_cfg}")

    # ── Overwrite GRUB.CFG in its existing cluster ────────────────────────
    write_cluster(grub_entry['first_cluster'], new_data)

    # ── Update directory entry file size ──────────────────────────────────
    # Re-read the directory to find the exact position and write the new size
    dir_data = read_cluster_chain(fedora_dir)
    offset = 0
    while offset < len(dir_data):
        entry = dir_data[offset:offset + 32]
        if entry[0] == 0:
            break
        if entry[0] == 0xE5 or entry[11] == 0x0F:
            offset += 32
            continue
        name = entry[:11].decode('ascii', errors='replace')
        if 'GRUB' in name and 'CFG' in name:
            # Write new file size (4 bytes at offset 28)
            cluster_offset = data_offset + (fedora_dir - 2) * cluster_bytes
            size_offset = cluster_offset + offset + 28
            os.lseek(fd, size_offset, os.SEEK_SET)
            os.write(fd, struct.pack('<I', len(new_data)))
            print(f"Updated directory entry file size to {len(new_data)}")
            break
        offset += 32

    os.close(fd)
    print("GRUB.CFG patched successfully!")


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <disk.raw>")
        sys.exit(1)
    patch_grub_cfg(sys.argv[1])
