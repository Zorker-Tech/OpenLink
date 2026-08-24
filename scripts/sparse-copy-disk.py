#!/usr/bin/env python3
"""Sparse-aware copy: transfers only data extents (SEEK_HOLE/SEEK_DATA),
creating a sparse destination file with holes for zero regions."""
import os
import sys
import time

def sparse_copy(src_path, dst_path, chunk_size=4 * 1024 * 1024):
    src_fd = os.open(src_path, os.O_RDONLY)
    try:
        src_size = os.fstat(src_fd).st_size
        print(f"Source: {src_path}")
        print(f"  Logical size: {src_size / 1024**3:.2f} GB")

        # Pre-create destination with full logical size (sparse)
        dst_fd = os.open(dst_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.ftruncate(dst_fd, src_size)

            offset = 0
            total_copied = 0
            extents = 0
            start_time = time.time()

            while offset < src_size:
                # Find next data region
                try:
                    data_start = os.lseek(src_fd, offset, os.SEEK_DATA)
                except OSError:
                    # No more data — all remaining is a hole
                    break

                # Find end of this data region (start of next hole)
                try:
                    hole_start = os.lseek(src_fd, data_start, os.SEEK_HOLE)
                except OSError:
                    hole_start = src_size

                extent_size = hole_start - data_start
                extents += 1

                # Copy this extent in chunks
                os.lseek(src_fd, data_start, os.SEEK_SET)
                os.lseek(dst_fd, data_start, os.SEEK_SET)

                remaining = extent_size
                while remaining > 0:
                    to_read = min(chunk_size, remaining)
                    data = os.read(src_fd, to_read)
                    if not data:
                        break
                    written = os.write(dst_fd, data)
                    if written < len(data):
                        # Partial write, seek back and retry
                        os.lseek(dst_fd, data_start + (extent_size - remaining) + written, os.SEEK_SET)
                        data = data[written:]
                        while data:
                            w = os.write(dst_fd, data)
                            data = data[w:]
                    remaining -= len(data)
                    total_copied += len(data)

                # Progress
                elapsed = time.time() - start_time
                speed = total_copied / elapsed / 1024**2 if elapsed > 0 else 0
                print(f"  Extent {extents}: {data_start/1024**3:.2f}GB +{extent_size/1024**3:.2f}GB | "
                      f"Total: {total_copied/1024**3:.2f}GB | {speed:.0f} MB/s | "
                      f"{elapsed:.0f}s")

                offset = hole_start

            os.fsync(dst_fd)

            # Verify
            dst_st = os.fstat(dst_fd)
            print(f"\nDestination: {dst_path}")
            print(f"  Logical size: {dst_st.st_size / 1024**3:.2f} GB")
            print(f"  Physical blocks: {dst_st.st_blocks * 512 / 1024**3:.2f} GB")
            print(f"  Extents copied: {extents}")
            print(f"  Data transferred: {total_copied / 1024**3:.2f} GB")
            elapsed = time.time() - start_time
            print(f"  Time: {elapsed:.1f}s")
            print(f"  Average speed: {total_copied / elapsed / 1024**2:.0f} MB/s")
        finally:
            os.close(dst_fd)
    finally:
        os.close(src_fd)

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <source> <destination>")
        sys.exit(1)
    sparse_copy(sys.argv[1], sys.argv[2])
