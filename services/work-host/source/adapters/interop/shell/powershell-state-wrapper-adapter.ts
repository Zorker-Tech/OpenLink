/** Produce the state-restoring command wrapper required by the supported shell runtime. */

const snapshotScript = "\nfunction Dump-PowerShellState {\n    param(\n        [Parameter(Mandatory = $true)]\n        [string]$OutputFile\n    )\n\n    function Emit {\n        param([string]$Content)\n        Add-Content -Path $OutputFile -Value $Content -Encoding UTF8\n    }\n\n    if (Test-Path $OutputFile) {\n        Remove-Item $OutputFile -Force\n    }\n    New-Item -Path $OutputFile -ItemType File -Force | Out-Null\n    #Log-Timing \"file_init\"\n\n    Emit $PWD.Path\n    #Log-Timing \"working_dir\"\n\n    function ShouldPersistEnvVar {\n        param([string]$Name)\n        if ($Name -eq 'SLATE_CONVERSATION_ID') {\n            return $false\n        }\n        if ($Name -like 'SLATE_AGENT_STORE*') {\n            return $false\n        }\n        if ($Name -like '*SLATE_SANDBOX*') {\n            return $false\n        }\n        return $true\n    }\n\n    $envVars = Get-ChildItem Env: | Sort-Object Name\n    foreach ($var in $envVars) {\n        if (-not (ShouldPersistEnvVar -Name $var.Name)) {\n            continue\n        }\n        $encoded = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$var.Value))\n        Emit ('Set-Item -LiteralPath ''Env:{0}'' -Value ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(''{1}'')))' -f $var.Name, $encoded)\n    }\n    #Log-Timing \"environment\"\n\n    $aliases = Get-Alias | Sort-Object Name\n    foreach ($alias in $aliases) {\n        $definition = $alias.Definition\n\n        if ($alias.Options -band [System.Management.Automation.ScopedItemOptions]::ReadOnly) {\n        }\n        elseif ($alias.Options -band [System.Management.Automation.ScopedItemOptions]::Constant) {\n        }\n        elseif ($alias.Options -band [System.Management.Automation.ScopedItemOptions]::AllScope) {\n        }\n        else {\n            Emit ('Set-Alias -Name \"{0}\" -Value \"{1}\"' -f $alias.Name, $definition)\n        }\n    }\n\n    #Log-Timing \"finalize\"\n}\n";

export function buildShellCommandStateWrapper(
  scriptState: string,
  workingDirectory: string,
  commandText: string,
  stateOutputFile: string,
): string {
  return `
${scriptState}

Set-Location '${workingDirectory}'

# Execute user command
${commandText}
$COMMAND_EXIT_CODE = $LASTEXITCODE

${snapshotScript}
Dump-PowerShellState -OutputFile "${stateOutputFile}"

exit $COMMAND_EXIT_CODE
`;
}
