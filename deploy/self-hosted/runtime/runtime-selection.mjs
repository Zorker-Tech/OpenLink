import { detectVirtualization, enableLinuxVirtualization, virtualizationHelp } from './virtualization.mjs'
import { resolveProjectRuntime } from './deployment-profile.mjs'
import { createInterface } from 'node:readline/promises'

function unavailableError(result) {
  const help = virtualizationHelp(result)
  return new Error(`${help.code}: ${help.message}; guide: ${help.guide}`)
}

export async function selectProjectRuntime(options = {}) {
  const requested = resolveProjectRuntime(options.requestedRuntime, { allowAuto: true })
  if (requested === 'container') {
    return { runtime: 'container', action: 'selected', detection: await (options.detect ?? detectVirtualization)({ ...options, projectRuntime: 'container' }) }
  }

  let detection = await (options.detect ?? detectVirtualization)({ ...options, projectRuntime: 'vm' })
  if (detection.status === 'ready') return { runtime: 'vm', action: 'ready', detection }

  const interactive = options.interactive === true
  const policy = options.policy ?? (interactive ? 'prompt' : 'fail')
  if (!['prompt', 'enable', 'container', 'fail'].includes(policy)) throw new Error('Virtualization policy must be prompt, enable, container, or fail')
  if (policy === 'enable') {
    if (!detection.repairable) throw unavailableError(detection)
    detection = await (options.enable ?? enableLinuxVirtualization)(options)
    return { runtime: 'vm', action: 'enabled', detection }
  }
  if (policy === 'container') {
    if (requested === 'vm' && options.acknowledgeIsolationDowngrade !== true) {
      throw new Error('Selecting Container instead of the configured VM backend requires --acknowledge-isolation-downgrade=1')
    }
    return { runtime: 'container', action: 'container-selected', detection }
  }
  if (policy === 'fail' || !interactive || typeof options.prompt !== 'function') throw unavailableError(detection)

  while (true) {
    const choices = detection.repairable ? ['enable', 'container', 'help', 'exit'] : ['container', 'help', 'exit']
    const choice = await options.prompt({ requestedRuntime: requested, detection, choices })
    if (choice === 'help') {
      await options.showHelp?.(virtualizationHelp(detection))
      continue
    }
    if (choice === 'enable' && detection.repairable) {
      detection = await (options.enable ?? enableLinuxVirtualization)(options)
      return { runtime: 'vm', action: 'enabled', detection }
    }
    if (choice === 'container') return { runtime: 'container', action: 'container-selected', detection }
    if (choice === 'exit') throw new Error('Project runtime selection was cancelled')
    throw new Error(`Invalid Project runtime selection: ${String(choice)}`)
  }
}

export async function terminalProjectRuntimePrompt({ detection, choices }, options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const labels = {
    enable: '安装/启用 QEMU + KVM 并继续（推荐）',
    container: '保持当前部署规格，改用 Docker Container 后端',
    help: '查看 KVM 诊断与启用教程',
    exit: '退出',
  }
  output.write(`\nProject VM 启动条件未满足：${detection.message ?? detection.code}\n`)
  choices.forEach((choice, index) => output.write(`${index + 1}. ${labels[choice]}\n`))
  const readline = createInterface({ input, output })
  try {
    const answer = (await readline.question('请选择：')).trim().toLowerCase()
    const numeric = Number(answer)
    if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= choices.length) return choices[numeric - 1]
    if (choices.includes(answer)) return answer
    throw new Error(`无效选择：${answer || '<empty>'}`)
  } finally {
    readline.close()
  }
}

export async function terminalVirtualizationHelp(help, options = {}) {
  const output = options.output ?? process.stdout
  output.write(`\n${help.code}: ${help.message}\n教程：${help.guide}\n\n`)
}
