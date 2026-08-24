#!/usr/bin/env python3
# Extract a single GNU-sparse member from a gzip-compressed tar archive into a
# true sparse file on the host filesystem.
#
# macOS ships only BSD libarchive tar (/usr/bin/tar), which understands GNU
# sparse extent maps well enough to list them but materialises every hole as
# explicit zero bytes on extraction. For a 64 GiB Golden Disk that carries
# only ~9 GiB of real data, that turns a sparse publish into a 64 GiB thick
# write that exhausts the host volume. GNU tar is unavailable on the host
# (Homebrew is not a runtime dependency), so this helper parses the GNU sparse
# 1.0 extent map with Python's stdlib tarfile, then streams only the packed
# real-data extents (holes are never read) into a file pre-sized with
# ftruncate, which on APFS yields a genuinely sparse file. The runtime later
# copy-on-write clones this file with clonefile(2), which depends on the
# sparse layout being preserved.
#
# Contract:
#   python3 extract-sparse-disk.py <archive> <member-name> <destination>
# Exit codes: 0 success, 2 usage, 3 format, 4 io.
from __future__ import annotations

import gzip
import os
import sys
import tarfile


def fail(code: int, message: str) -> None:
    sys.stderr.write(f"extract-sparse-disk: {message}\n")
    sys.exit(code)


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        fail(2, f"usage: {argv[0]} <archive> <member-name> <destination>")
    archive, member_name, destination = argv[1:4]

    # 1. Parse the sparse member header from the gzip tar stream. tarfile
    #    parses GNU sparse 1.0 extent maps into member.sparse as a list of
    #    (logical_offset, num_real_bytes) tuples, ordered ascending, with a
    #    final (0, 0) sentinel. member.offset_data is the byte offset within
    #    the *decompressed* tar at which the packed real-data stream begins.
    try:
        tf = tarfile.open(archive, "r|gz")
    except (OSError, tarfile.TarError) as error:
        fail(4, f"cannot open archive {archive}: {error}")

    member = None
    try:
        for m in tf:
            if m.name == member_name:
                member = m
                break
    except (OSError, tarfile.TarError) as error:
        tf.close()
        fail(4, f"cannot read archive {archive}: {error}")

    if member is None:
        tf.close()
        fail(3, f"member {member_name!r} not found in {archive}")
    if member.type != b"S":
        tf.close()
        fail(3, f"member {member_name!r} is not a GNU sparse file (type {member.type!r})")
    if not member.sparse:
        tf.close()
        fail(3, f"member {member_name!r} has no sparse extent map")
    if member.offset_data is None or member.offset_data < 0:
        tf.close()
        fail(3, f"member {member_name!r} has no data offset")

    extents = [(int(off), int(num)) for off, num in member.sparse if int(num) > 0]
    logical_size = member.size
    data_offset = member.offset_data
    real_bytes = sum(num for _, num in extents)
    tf.close()

    if logical_size <= 0:
        fail(3, f"member {member_name!r} has non-positive logical size {logical_size}")

    # 2. Re-open the raw gzip stream and seek to the packed-data region. The
    #    packed region is the concatenation of each extent's real bytes, in
    #    the order of the extent map; holes are simply absent. We read it
    #    sequentially and lseek/write each extent to its logical offset,
    #    leaving the holes as ftruncate-created sparse space.
    try:
        gz = gzip.open(archive, "rb")
    except OSError as error:
        fail(4, f"cannot reopen archive {archive}: {error}")

    try:
        gz.seek(data_offset)
    except OSError as error:
        gz.close()
        fail(4, f"cannot seek to data offset {data_offset}: {error}")

    tmp_destination = f"{destination}.extract-{os.getpid()}.tmp"
    try:
        fd = os.open(tmp_destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    except OSError as error:
        gz.close()
        fail(4, f"cannot create {tmp_destination}: {error}")

    try:
        # Pre-size to the full logical length. On APFS ftruncate extends a
        # file without allocating physical blocks, so the holes cost nothing.
        os.ftruncate(fd, logical_size)
        packed_remaining = real_bytes
        for offset, numbytes in extents:
            if offset < 0 or offset + numbytes > logical_size:
                fail(3, f"sparse extent ({offset},{numbytes}) exceeds logical size {logical_size}")
            want = numbytes
            os.lseek(fd, offset, os.SEEK_SET)
            while want > 0:
                chunk = gz.read(min(want, 16 * 1024 * 1024))
                if not chunk:
                    fail(3, f"packed stream ended early; {packed_remaining} of {real_bytes} bytes still expected")
                view = memoryview(chunk)
                wrote = 0
                while wrote < len(chunk):
                    n = os.write(fd, view[wrote:])
                    if n <= 0:
                        fail(4, f"write failed at logical offset {offset + wrote}")
                    wrote += n
                want -= len(chunk)
                packed_remaining -= len(chunk)
        os.fsync(fd)
    except (OSError, EOFError) as error:
        fail(4, f"extraction failed: {error}")
    finally:
        os.close(fd)
        gz.close()

    # 3. Verify the on-disk allocation matches the sparse intent. The file
    #    must be logically 64 GiB but physically close to the real extent
    #    total; if allocation approaches the logical size the holes were not
    #    preserved and copy-on-write cloning would later inflate every VM.
    st = os.stat(tmp_destination)
    allocated = st.st_blocks * 512
    if st.st_size != logical_size:
        fail(4, f"extracted size {st.st_size} != logical {logical_size}")
    # Tolerate modest filesystem metadata overhead; the invariant is that
    # allocation stays well below the logical size and close to real_bytes.
    if allocated > real_bytes + 2 * 1024 * 1024 * 1024:
        fail(4, f"extracted file is not sparse: allocated {allocated} bytes vs real {real_bytes} bytes (logical {logical_size})")

    os.replace(tmp_destination, destination)
    sys.stdout.write(
        f'{{"member": "{member_name}", "destination": "{destination}", '
        f'"logicalBytes": {logical_size}, "realBytes": {real_bytes}, '
        f'"allocatedBytes": {allocated}, "extents": {len(extents)}}}\n'
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
