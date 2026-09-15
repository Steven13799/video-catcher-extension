$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $repoRoot 'scripts/install-native-host.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer syntax errors' }
$buildFunction = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Ensure-HostBuilt'
}, $true)
Invoke-Expression $buildFunction.Extent.Text
function cargo { $global:LASTEXITCODE = 17 }
$failed = $false
try { Ensure-HostBuilt } catch {
  if ($_.Exception.Message -notlike '*compilation failed*17*') { throw }
  $failed = $true
}
if (-not $failed) { throw 'Installer accepted a failed build' }
function cargo { $global:LASTEXITCODE = 0 }
Ensure-HostBuilt
Write-Output 'install-native-host: failed build stops; successful build continues'
