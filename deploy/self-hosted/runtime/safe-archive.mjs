import { createReadStream, createWriteStream } from 'node:fs'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, rm, statfs, symlink } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { safeReleasePath } from './release-contract.mjs'

function parseString(buffer) {
  const end = buffer.indexOf(0)
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('utf8')
}

export function parseTarNumber(buffer, label) {
  if ((buffer[0] & 0x80) !== 0) {
    if ((buffer[0] & 0x40) !== 0) throw new Error(`Archive ${label} must not be negative`)
    let value = BigInt(buffer[0] & 0x3f)
    for (const byte of buffer.subarray(1)) value = (value << 8n) | BigInt(byte)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Archive ${label} is out of range`)
    return Number(value)
  }
  const value = parseString(buffer).trim().replace(/^0+/, '') || '0'
  if (!/^[0-7]+$/.test(value)) throw new Error(`Archive ${label} is not octal`)
  const result = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Archive ${label} is out of range`)
  return result
}

function headerChecksum(header) {
  let sum = 0
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index]
  }
  return sum
}

function parsePax(contents) {
  const attributes = {}
  let offset = 0
  while (offset < contents.length) {
    const space = contents.indexOf(0x20, offset)
    if (space === -1) throw new Error('Archive PAX record has no length separator')
    const encodedLength = contents.subarray(offset, space).toString('ascii')
    if (!/^[1-9][0-9]*$/.test(encodedLength)) throw new Error('Archive PAX record length is invalid')
    const length = Number.parseInt(encodedLength, 10)
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > contents.length) throw new Error('Archive PAX record length is invalid')
    if (contents[offset + length - 1] !== 0x0a) throw new Error('Archive PAX record is not newline terminated')
    const record = contents.subarray(space + 1, offset + length - 1).toString('utf8')
    const separator = record.indexOf('=')
    if (separator <= 0) throw new Error('Archive PAX record is invalid')
    attributes[record.slice(0, separator)] = record.slice(separator + 1)
    offset += length
  }
  return attributes
}

function parsePaxSize(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('Archive PAX file size is invalid')
  const parsed = BigInt(value)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Archive PAX file size is out of range')
  return Number(parsed)
}

function positiveLimit(value, fallback, label) {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Archive ${label} limit must be a positive safe integer`)
  return parsed
}

async function safeDirectory(root, relative) {
  const output = resolve(root, ...relative.split('/'))
  if (output !== root && !output.startsWith(`${root}${sep}`)) throw new Error(`Archive path escapes extraction root: ${relative}`)
  await mkdir(output, { recursive: true, mode: 0o700 })
  return output
}

export async function extractVerifiedTarGzip(archive, destination, options = {}) {
  const archivePath = resolve(archive)
  const maximumArchiveBytes = positiveLimit(options.maximumArchiveBytes, 64 * 1024 ** 3, 'compressed size')
  const archiveBefore = await lstat(archivePath)
  if (!archiveBefore.isFile()) throw new Error(`Archive input is not a regular file: ${archivePath}`)
  if (archiveBefore.size > maximumArchiveBytes) throw new Error(`Archive compressed size exceeds ${maximumArchiveBytes} bytes`)
  const archiveHandle = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const archiveCurrent = await archiveHandle.stat()
  if (!archiveCurrent.isFile() || archiveCurrent.dev !== archiveBefore.dev || archiveCurrent.ino !== archiveBefore.ino || archiveCurrent.size !== archiveBefore.size) {
    await archiveHandle.close()
    throw new Error('Archive input changed while opening')
  }
  const root = resolve(destination)
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
  } catch (error) {
    await archiveHandle.close().catch(() => undefined)
    throw error
  }
  const stream = createReadStream(archivePath, { fd: archiveHandle.fd, autoClose: false }).pipe(createGunzip())
  let pending = Buffer.alloc(0)
  let state = { kind: 'header' }
  let pax = {}
  let longName
  let zeroBlocks = 0
  const paths = new Set()
  const symbolicPaths = new Set()
  const maximumFileBytes = positiveLimit(options.maximumFileBytes, 128 * 1024 ** 3, 'file size')
  const maximumFiles = positiveLimit(options.maximumFiles, 250_000, 'path count')
  const maximumEntries = positiveLimit(options.maximumEntries, 250_000, 'entry count')
  const maximumTotalBytes = positiveLimit(options.maximumTotalBytes, 192 * 1024 ** 3, 'expanded size')
  const maximumMetadataBytes = positiveLimit(options.maximumMetadataBytes, 16 * 1024 ** 2, 'metadata size')
  const minimumFreeBytesAfterExtraction = positiveLimit(options.minimumFreeBytesAfterExtraction, 512 * 1024 ** 2, 'free-space reserve')
  const filesystem = await statfs(root)
  const initialFreeBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
  const maximumWritableBytes = Math.max(0, initialFreeBytes - minimumFreeBytesAfterExtraction)
  let totalBytes = 0
  let entries = 0

  async function consumeHeader(header) {
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1
      return
    }
    if (zeroBlocks > 0) throw new Error('Archive contains data after an end marker')
    const expectedChecksum = parseTarNumber(header.subarray(148, 156), 'checksum')
    if (headerChecksum(header) !== expectedChecksum) throw new Error('Archive header checksum mismatch')
    const name = parseString(header.subarray(0, 100))
    const prefix = parseString(header.subarray(345, 500))
    const headerPath = prefix ? `${prefix}/${name}` : name
    const type = String.fromCharCode(header[156] || 0)
    const headerLink = parseString(header.subarray(157, 257))
    const mode = parseTarNumber(header.subarray(100, 108), 'file mode') & 0o7777
    if ((mode & 0o7000) !== 0) throw new Error('Archive entry may not set special permission bits')
    const headerSize = parseTarNumber(header.subarray(124, 136), 'file size')
    const sizeValue = pax.size === undefined ? headerSize : parsePaxSize(pax.size)
    if (!Number.isSafeInteger(sizeValue) || sizeValue < 0 || sizeValue > maximumFileBytes) throw new Error(`Archive file size is invalid: ${sizeValue}`)
    if (['x', 'g', 'L'].includes(type) && sizeValue > maximumMetadataBytes) throw new Error(`Archive metadata exceeds ${maximumMetadataBytes} bytes`)
    entries += 1
    if (!Number.isSafeInteger(entries) || entries > maximumEntries) throw new Error(`Archive contains more than ${maximumEntries} entries`)
    totalBytes += sizeValue
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumTotalBytes) throw new Error(`Archive expands beyond ${maximumTotalBytes} bytes`)
    if (totalBytes > maximumWritableBytes) throw new Error(`Archive would violate the ${minimumFreeBytesAfterExtraction} byte free-space reserve`)
    const rawPath = String(pax.path ?? longName ?? headerPath)
    const linkTarget = String(pax.linkpath ?? headerLink)
    const rootDirectory = type === '5' && (rawPath === '.' || rawPath === './')
    const relative = type === 'x' || type === 'g' || type === 'L' || rootDirectory
      ? undefined
      : safeReleasePath(rawPath.replace(/^\.\//, '').replace(/\/$/, ''))
    const padding = (512 - (sizeValue % 512)) % 512
    state = { kind: 'body', type, relative, remaining: sizeValue, padding, chunks: [], handle: undefined, output: undefined, mode }
    pax = {}
    longName = undefined

    if (relative) {
      if (paths.has(relative)) throw new Error(`Archive contains a duplicate path: ${relative}`)
      for (const symbolic of symbolicPaths) {
        if (relative.startsWith(`${symbolic}/`)) throw new Error(`Archive path traverses a symbolic link: ${relative}`)
      }
      paths.add(relative)
      if (paths.size > maximumFiles) throw new Error(`Archive contains more than ${maximumFiles} paths`)
      if (type === '5') {
        if (sizeValue !== 0) throw new Error(`Archive directory has a payload: ${relative}`)
        await safeDirectory(root, relative)
      } else if (type === '0' || type === '\0') {
        await safeDirectory(root, dirname(relative).split(sep).join('/'))
        const output = resolve(root, ...relative.split('/'))
        state.handle = await open(output, 'wx', 0o600)
        state.output = output
      } else if (options.allowSafeLinks === true && type === '2') {
        if (sizeValue !== 0 || !linkTarget || linkTarget.length > 1024 || linkTarget.startsWith('/') || linkTarget.includes('\\') || /[\0-\x1f\x7f]/.test(linkTarget)) {
          throw new Error(`Archive symbolic link target is unsafe: ${relative}`)
        }
        const output = resolve(root, ...relative.split('/'))
        const resolvedTarget = resolve(dirname(output), ...linkTarget.split('/'))
        if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) throw new Error(`Archive symbolic link escapes extraction root: ${relative}`)
        await safeDirectory(root, dirname(relative).split(sep).join('/'))
        await symlink(linkTarget, output)
        symbolicPaths.add(relative)
      } else if (options.allowSafeLinks === true && type === '1') {
        if (sizeValue !== 0) throw new Error(`Archive hard link has a payload: ${relative}`)
        const targetRelative = safeReleasePath(linkTarget.replace(/^\.\//, '').replace(/\/$/, ''))
        const target = resolve(root, ...targetRelative.split('/'))
        if (!paths.has(targetRelative) || !(await lstat(target).catch(() => undefined))?.isFile()) throw new Error(`Archive hard link target is unavailable: ${relative}`)
        await safeDirectory(root, dirname(relative).split(sep).join('/'))
        await link(target, resolve(root, ...relative.split('/')))
      } else {
        throw new Error(`Archive entry type ${JSON.stringify(type)} is forbidden: ${relative}`)
      }
    } else if (!rootDirectory && !['x', 'g', 'L'].includes(type)) {
      throw new Error(`Archive metadata entry type ${JSON.stringify(type)} is unsupported`)
    }
  }

  async function consumeBody(chunk) {
    if (state.handle) await state.handle.write(chunk)
    else if (state.type === 'x' || state.type === 'g' || state.type === 'L') state.chunks.push(chunk)
    state.remaining -= chunk.length
    if (state.remaining !== 0) return
    if (state.handle) {
      await state.handle.sync()
      await state.handle.close()
      state.handle = undefined
      await chmod(state.output, state.mode)
    }
    const metadata = state.chunks.length ? Buffer.concat(state.chunks) : Buffer.alloc(0)
    if (state.type === 'x' || state.type === 'g') pax = { ...pax, ...parsePax(metadata) }
    if (state.type === 'L') longName = metadata.subarray(0, metadata.indexOf(0) === -1 ? metadata.length : metadata.indexOf(0)).toString('utf8')
    state = { kind: 'padding', remaining: state.padding }
    if (state.remaining === 0) state = { kind: 'header' }
  }

  try {
    for await (const chunk of stream) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length) {
        if (state.kind === 'header') {
          if (pending.length < 512) break
          const header = pending.subarray(0, 512)
          pending = pending.subarray(512)
          await consumeHeader(header)
          continue
        }
        if (state.kind === 'body') {
          if (state.remaining === 0) {
            await consumeBody(Buffer.alloc(0))
            continue
          }
          const length = Math.min(state.remaining, pending.length)
          if (length === 0) break
          const body = pending.subarray(0, length)
          pending = pending.subarray(length)
          await consumeBody(body)
          continue
        }
        const length = Math.min(state.remaining, pending.length)
        pending = pending.subarray(length)
        state.remaining -= length
        if (state.remaining === 0) state = { kind: 'header' }
      }
    }
    if (state.kind !== 'header' || (pending.length !== 0 && !pending.every((byte) => byte === 0))) throw new Error('Archive ended with an incomplete entry')
    if (zeroBlocks < 2) throw new Error('Archive end marker is missing')
    return { files: paths.size }
  } catch (error) {
    await state.handle?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
    throw error
  } finally {
    await archiveHandle.close().catch(() => undefined)
  }
}
