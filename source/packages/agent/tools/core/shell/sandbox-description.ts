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
      sandboxNetworkInfo.hasDefaults && jsx("p", { children: "The sandbox includes network access for common package managers and version control providers (e.g. npm, pypi, crates.io, Maven Central, GitHub, etc.). Standard operations like package installs and fetching dependencies will work without requesting additional permissions." }),
      sandboxNetworkInfo.explicitEntries.length > 0 && jsxs("p", { children: [sandboxNetworkInfo.hasDefaults ? "Additionally, the" : "The", " sandbox includes network access for the following domains:", " ", sandboxNetworkInfo.explicitEntries.join(", "), ". You do not need to request 'full_network' permissions for these domains."] }),
      jsx("p", { children: "For broader network access beyond the allowed domains, you may still need to request 'full_network' permissions." }),
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
        jsxs("p", { children: ["Your commands will run in a readonly sandbox. The sandbox allows reads to the filesystem but does not allow any writes.", hasNetworkInsideSandbox ? "" : " Network access is disallowed by default but can be requested with the full_network permission."] }),
        hasNetworkInsideSandbox && jsx(NetworkAllowlistDescription, { sandboxNetworkInfo }),
        jsx("p", { children: "The required_permissions argument is used to request additional permissions:" }),
        jsx("ul", { children: jsx("li", { children: hasNetworkInsideSandbox ? "full_network: Grants unrestricted network access beyond the allowed domains." : "full_network: Grants unrestricted network access." }) }),
      ],
    })
  }
  return jsxs(Fragment, {
    children: [
      jsx("p", { children: "By default, your commands will run in a sandbox. The sandbox allows most writes to the workspace and reads to the rest of the filesystem. Some other syscalls are also disallowed like access to USB devices. Syscalls that attempt forbidden operations will fail and not all programs will surface these errors in a useful way." }),
      hasNetworkInsideSandbox && jsx(NetworkAllowlistDescription, { sandboxNetworkInfo }),
      jsx("p", { children: `Files that are ignored by ${WORKSPACE_IGNORE_FILE_NAME} are not accessible to the command. If you need to access a file that is ignored, you will need to request "all" permissions to disable sandboxing.` }),
      jsx("p", { children: "The required_permissions argument is used to request additional permissions. If you know you will need a permission, request it. Requesting permissions will slow down the command execution as it will ask the user for approval. Do not hesitate to request permissions if you are certain you need them. For commands you know will need unrestricted network access, request the full_network permission rather than waiting for the command to fail and asking for it later." }),
      jsx("p", { children: "The following permissions are supported:" }),
      jsxs("ul", {
        children: [
          !hasNetworkInsideSandbox && jsx("li", { children: "full_network: Grants unrestricted network access to run a server or contact the internet. Needed for package installs, API calls, hosting servers and fetching dependencies." }),
          hasNetworkInsideSandbox && jsx("li", { children: "full_network: Grants unrestricted network access. This is useful for any commands that need to contact the outside internet, outside of the allowed domains." }),
          jsx("li", { children: "all: Disables the sandbox entirely. If all is requested the command will run outside of the sandbox." }),
        ],
      }),
      jsx("p", { children: "If you think a command failed due to sandbox restrictions, run the command again with the required_permissions argument to request what you need." }),
    ],
  })
}

export function SandboxingDescription(props: PromptProps): PromptNode {
  return jsx("section", { title: "Sandboxing", children: jsx(SandboxingDescriptionBody as unknown as (props: PromptProps) => PromptNode, props) })
}
