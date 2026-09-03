import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { lstat, open, readdir, rename, rm, writeFile } from 'node:fs/promises'

export async function syncFile(path) {
  const handle = await open(resolve(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error(`Durability target is not a regular file: ${path}`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function syncDirectory(path) {
  const handle = await open(resolve(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function durableWriteFile(path, data, options = {}) {
  await writeFile(path, data, options)
  try {
    await syncFile(path)
    await syncDirectory(dirname(resolve(path)))
  } catch (error) {
    if (String(options.flag ?? '').includes('x')) await rm(path, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function durableRename(source, destination) {
  const sourceParent = dirname(resolve(source))
  const destinationParent = dirname(resolve(destination))
  await rename(source, destination)
  await syncDirectory(destinationParent)
  if (sourceParent !== destinationParent) await syncDirectory(sourceParent)
}

export async function syncTree(path) {
  const absolute = resolve(path)
  const stats = await lstat(absolute)
  if (stats.isFile()) {
    await syncFile(absolute)
    return
  }
  if (stats.isSymbolicLink()) return
  if (!stats.isDirectory()) throw new Error(`Durability tree contains an unsupported filesystem object: ${absolute}`)
  for (const name of await readdir(absolute)) await syncTree(join(absolute, name))
  await syncDirectory(absolute)
}
