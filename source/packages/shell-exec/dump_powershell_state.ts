/**
 * The PowerShell script that reports a shell's own state, and the wrapper that runs a command with it.
 *
 * PowerShell has no single form that can be replayed, so the script writes the state as the commands that
 * would set it: each environment variable as a `Set-Item` that decodes its own value, and each alias as a
 * `Set-Alias`, skipping the ones whose options make them read-only, constant or shared, since those are the
 * shell's own and not the user's. Variables that belong to a single request — the conversation, the agent's
 * store, the sandbox — are deliberately not carried into the snapshot, because a snapshot outlives the
 * request it was taken in.
 *
 * The wrapper is what a command is actually run through: it restores the state, moves to the working
 * directory, runs the command, keeps its exit code, writes the state back out, and exits with the code the
 * command returned rather than the one the dump happened to finish with.
 */

const powershellScript = "\nfunction Dump-PowerShellState {\n    param(\n        [Parameter(Mandatory = $true)]\n        [string]$OutputFile\n    )\n\n    function Emit {\n        param([string]$Content)\n        Add-Content -Path $OutputFile -Value $Content -Encoding UTF8\n    }\n\n    if (Test-Path $OutputFile) {\n        Remove-Item $OutputFile -Force\n    }\n    New-Item -Path $OutputFile -ItemType File -Force | Out-Null\n    #Log-Timing \"file_init\"\n\n    Emit $PWD.Path\n    #Log-Timing \"working_dir\"\n\n    function ShouldPersistEnvVar {\n        param([string]$Name)\n        if ($Name -eq 'SLATE_CONVERSATION_ID') {\n            return $false\n        }\n        if ($Name -like 'SLATE_AGENT_STORE*') {\n            return $false\n        }\n        if ($Name -like '*SLATE_SANDBOX*') {\n            return $false\n        }\n        return $true\n    }\n\n    $envVars = Get-ChildItem Env: | Sort-Object Name\n    foreach ($var in $envVars) {\n        if (-not (ShouldPersistEnvVar -Name $var.Name)) {\n            continue\n        }\n        $encoded = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$var.Value))\n        Emit ('Set-Item -LiteralPath ''Env:{0}'' -Value ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(''{1}'')))' -f $var.Name, $encoded)\n    }\n    #Log-Timing \"environment\"\n\n    $aliases = Get-Alias | Sort-Object Name\n    foreach ($alias in $aliases) {\n        $definition = $alias.Definition\n\n        if ($alias.Options -band [System.Management.Automation.ScopedItemOptions]::ReadOnly) {\n        }\n        elseif ($alias.Options -band [System.Management.Automation.ScopedItemOptions]::Constant) {\n        }\n        elseif ($alias.Options -band [System.Management.Automation.ScopedItemOptions]::AllScope) {\n        }\n        else {\n            Emit ('Set-Alias -Name \"{0}\" -Value \"{1}\"' -f $alias.Name, $definition)\n        }\n    }\n\n    #Log-Timing \"finalize\"\n}\n";

const powershellWrapperScript = (state: string, cwd: string, command: string, stateOutFile: string): string => `
${state}

Set-Location '${cwd}'

# Execute user command
${command}
$COMMAND_EXIT_CODE = $LASTEXITCODE

${powershellScript}
Dump-PowerShellState -OutputFile "${stateOutFile}"

exit $COMMAND_EXIT_CODE
`;

export default powershellWrapperScript;
