<#
.SYNOPSIS
  Measure Salesforce CLI startup and cached-org discovery on Windows.
.DESCRIPTION
  Never prints CLI stdout/stderr, usernames, org IDs, auth tokens, or URLs.
  Use timings to choose whether the Analyzer should change its CLI strategy.
  This script does not log in, modify org authorizations, or write files.
.EXAMPLE
  .\scripts\Measure-SalesforceCli.ps1
.EXAMPLE
  .\scripts\Measure-SalesforceCli.ps1 -Runs 3 -OrgAlias "my-sandbox"
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 5)]
    [int] $Runs = 3,
    [string] $OrgAlias = ""
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command "sf" -ErrorAction SilentlyContinue)) {
    throw "Salesforce CLI executable 'sf' was not found on PATH."
}

$checks = @(
    @{ Name = "CLI version"; Args = @("--version"); Iterations = $Runs }
    @{ Name = "Saved orgs (auth)"; Args = @("org", "list", "auth", "--json"); Iterations = $Runs }
    @{ Name = "Saved orgs (skip status)"; Args = @("org", "list", "--skip-connection-status", "--json"); Iterations = $Runs }
)

if ($OrgAlias.Trim()) {
    # Token retrieval runs once. It can refresh auth, so do not repeat unnecessarily.
    # Output and errors are discarded and the alias is never displayed.
    $checks += @{ Name = "Access token (optional)"; Args = @(
        "org", "auth", "show-access-token", "--target-org", $OrgAlias, "--json"
    ); Iterations = 1 }
}

Write-Host "Measuring local Salesforce CLI commands. No credentials or CLI responses will be printed."
$results = foreach ($check in $checks) {
    for ($i = 1; $i -le $check.Iterations; $i++) {
        $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
        # Do not inspect or persist the command response: token output is sensitive.
        & sf @($check.Args) *> $null
        $exit = $LASTEXITCODE
        $elapsed.Stop()
        [PSCustomObject]@{
            Operation = $check.Name
            Run = $i
            Seconds = [math]::Round($elapsed.Elapsed.TotalSeconds, 2)
            Success = ($exit -eq 0)
        }
    }
}
$results | Format-Table -AutoSize
Write-Host "Share only this summary table. Do not share verbose CLI JSON or auth files."
