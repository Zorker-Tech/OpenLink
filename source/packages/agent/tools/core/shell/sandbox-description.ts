/**
 * What the model is told about the sandbox its commands run in.
 *
 * A sandboxed command that fails does so in a way that is often not explained: a write is refused, a
 * syscall is denied, a network call hangs, and the program reports it as a plain error. So the model is
 * told what the sandbox allows before it runs anything — which is why the two session kinds are
 * described separately, a read-only one having no writes at all — and it is told how to ask for more:
 * the argument that requests a permission, what each permission grants, and that asking costs an
 * approval, so it should ask when it knows it needs one rather than after a failure.
 *
 * The network part is conditional on the sandbox's own allowlist: a sandbox with default or explicit
 * domains is one where installs already work, and saying so keeps the model from requesting the network
 * for something that already has it.
 */

import { Fragment, jsx, jsxs, type PromptNode, type PromptProps } from "../../../../prompt-jsx/index.ts"
import { WORKSPACE_IGNORE_FILE_NAME } from "../../../../constants/box-archive.ts"

import { hasNetworkAllowlist, type SandboxNetworkInfo } from "./sandbox-permissions.ts"

export function NetworkAllowlistDescription(props: PromptProps): PromptNode {
  const sandboxNetworkInfo = props.sandboxNetworkInfo as SandboxNetworkInfo
  return jsxs(Fragment, {
    children: [
      sandboxNetworkInfo.hasDefaults && jsx("p", { children: "The sandbox already allows connections to common package managers and version control providers. Package installs and dependency fetches should work without another permission request." }),
      sandboxNetworkInfo.explicitEntries.length > 0 && jsxs("p", { children: [sandboxNetworkInfo.hasDefaults ? "It also" : "The sandbox", " allows network access for the following domains:", " ", sandboxNetworkInfo.explicitEntries.join(", "), ". These destinations do not require 'full_network'."] }),
      jsx("p", { children: "For destinations outside the allowed domains, request 'full_network' when the task needs wider access." }),
    ],
  })
}

export function SandboxingDescriptionBody(props: PromptProps): PromptNode {
  const isReadonly = props.isReadonly as boolean
  const sandboxNetworkInfo = props.sandboxNetworkInfo as SandboxNetworkInfo
  const hasNetworkInsideSandbox = hasNetworkAllowlist(sandboxNetworkInfo)
  if (isReadonly) {
    return jsxs(Fragment, {
      children: [
        jsxs("p", { children: ["Commands run in a readonly sandbox: they can read the filesystem but cannot write to it.", hasNetworkInsideSandbox ? "" : " Network access is disallowed by default and can be requested with full_network."] }),
        hasNetworkInsideSandbox && jsx(NetworkAllowlistDescription, { sandboxNetworkInfo }),
        jsx("p", { children: "Use required_permissions to ask for an additional capability:" }),
        jsx("ul", { children: jsx("li", { children: hasNetworkInsideSandbox ? "full_network: Grants unrestricted network access beyond the allowed domains." : "full_network: Grants unrestricted network access." }) }),
      ],
    })
  }
  return jsxs(Fragment, {
    children: [
      jsx("p", { children: "Commands run in a sandbox by default. The sandbox allows most writes to the workspace and reads elsewhere on the filesystem. It blocks some system calls, including access to USB devices; a blocked operation may appear as an ordinary command error." }),
      hasNetworkInsideSandbox && jsx(NetworkAllowlistDescription, { sandboxNetworkInfo }),
      jsx("p", { children: `Files excluded by ${WORKSPACE_IGNORE_FILE_NAME} cannot be read or written by this command. Request "all" if the task requires those files; that runs the command without sandboxing.` }),
      jsx("p", { children: "Request additional permissions through required_permissions. Ask when the need is clear, since each request waits for user approval. If unrestricted network access is needed, request full_network before running the command." }),
      jsx("p", { children: "Available permissions:" }),
      jsxs("ul", {
        children: [
          !hasNetworkInsideSandbox && jsx("li", { children: "full_network: Grants unrestricted network access for package installs, API calls, servers and dependency fetches. Needed for package installs and internet requests." }),
          hasNetworkInsideSandbox && jsx("li", { children: "full_network: Grants unrestricted network access beyond the destinations already allowed." }),
          jsx("li", { children: "all: Disables the sandbox entirely and runs the command without its restrictions." }),
        ],
      }),
      jsx("p", { children: "If a failure appears to come from a sandbox restriction, rerun the command with the needed value in required_permissions." }),
    ],
  })
}

export function SandboxingDescription(props: PromptProps): PromptNode {
  return jsx("section", { title: "Sandboxing", children: jsx(SandboxingDescriptionBody as unknown as (props: PromptProps) => PromptNode, props) })
}
