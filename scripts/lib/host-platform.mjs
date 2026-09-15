import { delimiter, posix, win32 } from 'node:path'

const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64'])

function pathsForPlatform(platform) {
  return platform === 'win32' ? win32 : posix
}

export function resolveHostPlatform(options = {}) {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const env = options.env ?? process.env

  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`OpenLink does not support host architecture ${architecture}`)
  }

  if (platform === 'darwin') {
    if (architecture !== 'arm64') throw new Error('OpenLink AppleHV support requires macOS arm64')
    return {
      platform,
      architecture,
      provider: 'applehv',
      diskFormat: 'raw',
      executableSuffix: '',
      pathDelimiter: ':',
      dockerDesktopCandidates: [
        '/Applications/Docker.app/Contents/MacOS/Docker',
      ],
      dockerCliCandidates: ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'],
      chromiumCandidates: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ],
    }
  }

  if (platform === 'win32') {
    const { resolve } = pathsForPlatform(platform)
    const localAppData = env.LOCALAPPDATA?.trim()
    const programFiles = env.ProgramFiles?.trim() || 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)'
    return {
      platform,
      architecture,
      provider: 'hyperv',
      diskFormat: 'vhdx',
      executableSuffix: '.exe',
      pathDelimiter: ';',
      dockerDesktopCandidates: [
        ...(localAppData ? [resolve(localAppData, 'Programs', 'DockerDesktop', 'Docker Desktop.exe')] : []),
        resolve(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'),
      ],
      dockerCliCandidates: [
        ...(localAppData ? [resolve(localAppData, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe')] : []),
        resolve(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
      ],
      chromiumCandidates: [
        ...(localAppData ? [
          resolve(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          resolve(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          resolve(localAppData, 'Chromium', 'Application', 'chrome.exe'),
        ] : []),
        resolve(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        resolve(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        resolve(programFiles, 'Chromium', 'Application', 'chrome.exe'),
        resolve(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        resolve(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
    }
  }

  if (platform === 'linux') {
    return {
      platform,
      architecture,
      provider: 'qemu',
      diskFormat: 'qcow2',
      executableSuffix: '',
      pathDelimiter: ':',
      dockerDesktopCandidates: [],
      dockerCliCandidates: ['/usr/bin/docker', '/usr/local/bin/docker'],
      chromiumCandidates: [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ],
    }
  }

  throw new Error(`OpenLink does not support host platform ${platform}`)
}

/**
 * Resolve state that contains per-user credentials. Windows workspace
 * volumes may deliberately grant Hyper-V service identities access to VM
 * disks, and some enterprise volumes do not permit a non-elevated process to
 * replace DACLs even when the user owns a file. Keep credentials in the
 * native per-user profile security boundary instead. Existing macOS/Linux
 * paths remain repository-local for compatibility.
 */
export function resolveUserStateRoot(productRoot, options = {}) {
  const host = options.host ?? resolveHostPlatform(options)
  const { resolve } = pathsForPlatform(host.platform)
  if (host.platform !== 'win32') return resolve(productRoot, '.openlink-runtime')
  const env = options.env ?? process.env
  const localAppData = env.LOCALAPPDATA?.trim()
  if (!localAppData) throw new Error('Windows per-user OpenLink state requires LOCALAPPDATA')
  return resolve(localAppData, 'OpenLink', 'state')
}

export function executableName(name, platform = process.platform) {
  if (platform !== 'win32' || /\.[A-Za-z0-9]+$/.test(name)) return name
  return `${name}.exe`
}

export function packageManagerCommand(name, platform = process.platform) {
  if (platform === 'win32' && (name === 'npm' || name === 'pnpm' || name === 'npx')) return `${name}.cmd`
  return name
}

export function prependPath(directory, current = process.env.PATH ?? '', platform = process.platform) {
  const separator = platform === process.platform ? delimiter : platform === 'win32' ? ';' : ':'
  return current ? `${directory}${separator}${current}` : directory
}

export function bundledToolchainPaths(root, platform = process.platform) {
  const { resolve } = pathsForPlatform(platform)
  const bin = resolve(root, '.openlink-runtime', 'toolchain', 'bin')
  return {
    bin,
    podman: resolve(bin, executableName('podman', platform)),
    gvproxy: resolve(bin, executableName('gvproxy', platform)),
    winSshProxy: platform === 'win32' ? resolve(bin, 'win-sshproxy.exe') : undefined,
    vfkit: platform === 'darwin' ? resolve(bin, 'vfkit') : undefined,
  }
}
