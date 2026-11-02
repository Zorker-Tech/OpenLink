/**
 * Resolve the Project computer architecture selected by the root lifecycle
 * command. T1 (Ubuntu Project VM + native desktop) is the default; E1
 * (Podman machine OS + per-chat container desktop) is explicit via `-e1`.
 *
 * Kept in a small module so the selection contract is testable without
 * booting the supervisor or any Project VM.
 */
export function resolveArchitecture(args, env = process.env) {
  let architecture
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '-e1' || argument === '--e1' || argument === '--arch=e1' || argument === '--architecture=e1') {
      architecture = 'e1'
      continue
    }
    if (argument === '-t1' || argument === '--t1' || argument === '--arch=t1' || argument === '--architecture=t1') {
      architecture = 't1'
      continue
    }
    if (argument === '-t2' || argument === '--t2' || argument === '--arch=t2' || argument === '--architecture=t2') {
      architecture = 't2'
      continue
    }
    if (argument === '--arch' || argument === '--architecture') {
      const value = args[index + 1]?.trim().toLowerCase()
      if (value !== 't1' && value !== 't2' && value !== 'e1') throw new Error('OpenLink architecture must be t1, t2 or e1')
      architecture = value
      index += 1
    }
  }
  architecture ||= env.OPENLINK_ARCHITECTURE?.trim().toLowerCase() || 't1'
  if (architecture !== 't1' && architecture !== 't2' && architecture !== 'e1') {
    throw new Error('OpenLink architecture must be t1, t2 or e1')
  }
  return architecture
}
