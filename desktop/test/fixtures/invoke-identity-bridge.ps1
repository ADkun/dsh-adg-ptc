# Fixture bridge for test/element-identity.test.mjs -- NOT the real bridge (scripts/bridge.ps1).
#
# The identity decision itself is never re-implemented here: it is dot-sourced from the real bridge's
# own scripts/identity.ps1 (see the dot-source below), so the executing test runs the same code.
#
# It answers the four commands cli.mjs `invoke` needs (uia locate / profile / verify / uia -Invoke)
# with canned JSON, so that the landing half of an invoke can be exercised WITHOUT touching a real
# desktop (no window is enumerated, no input is synthesised, nothing is written outside -Out).
#
# Two knobs, both test-only, come from the environment:
#   ADG_FIXTURE_SNAPSHOT_RUNTIME_ID    runtime id reported by the LOCATING snapshot  (default 42.1000.7)
#   ADG_FIXTURE_SECOND_PASS_RUNTIME_ID runtime id reported by the ACTING walk       (default 42.9999.9)
# The defaults disagree on purpose: counting the hits happens on the caller's snapshot while the
# acting happens on a SECOND walk of the tree, and the only thing that travels between them is a
# hash of the runtime id. That is exactly the gap design.md I6f closes.
param(
  [Parameter(Mandatory = $true)][string]$Command,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Hwnd = '',
  [string]$X = '',
  [string]$Y = '',
  [int]$Depth = 16,
  [string]$Name = '',
  [string]$ElId = '',
  [string]$ElRuntimeId = '',
  [string]$SetValue = '',
  [int]$Limit = 3000,
  [switch]$Invoke
)

function Env-Or([string]$Key, [string]$Fallback) {
  $value = [string][System.Environment]::GetEnvironmentVariable($Key)
  if ($null -eq $value -or $value -eq '') { return $Fallback }
  return $value
}

# The element identity check is NOT re-implemented below. This fixture dots in the real bridge's own
# decision module, so a mutation of that decision (or of the report it returns) turns the executing
# test red -- the code under test is literally the code the real bridge runs.
. (Join-Path $PSScriptRoot '..\..\scripts\identity.ps1')

$json = ''
if ($Command -eq 'profile') {
  $json = '{"ok":true,"screen":{"virtualLeft":0,"virtualTop":0,"virtualWidth":2560,"virtualHeight":1600,"width":2560,"height":1600}}'
} elseif ($Command -eq 'verify') {
  $json = '{"ok":true,"verify":{"foreground":"0x1","foregroundTitle":"fixture","windowCount":1,"titlesDigest":"fixture"}}'
} elseif ($Command -eq 'uia') {
  if ($Invoke) {
    $actual = Env-Or 'ADG_FIXTURE_SECOND_PASS_RUNTIME_ID' '42.9999.9'
    # Same function, same report object as scripts/bridge.ps1's Do-InvokeChosen: what comes out here
    # is what the real bridge would hand to Write-Report.
    $gate = Get-ElementIdentityGate -Expected $ElRuntimeId -Actual $actual -ElementId $ElId
    if ($null -ne $gate) {
      $json = ($gate | ConvertTo-Json -Compress)
    } else {
      $json = '{"ok":true,"invoked":true,"elementId":"' + $ElId + '","pattern":"InvokePattern","valueBefore":"","valueAfter":"","patterns":["InvokePattern"]}'
    }
  } else {
    $snapshot = Env-Or 'ADG_FIXTURE_SNAPSHOT_RUNTIME_ID' '42.1000.7'
    # '-' means "this element has no runtime id at all" -- the shape New-Node produces when
    # GetRuntimeId() fails (it also collapses the id to el_unknown there).
    if ($snapshot -eq '-') { $snapshot = '' }
    $json = '{"ok":true,"elements":[{"id":"' + $ElId + '","runtimeId":"' + $snapshot + '","controlType":"Button","name":"fixture","automationId":"fixture","rect":null,"patterns":["InvokePattern"],"level":0}],"count":1,"depth":' + $Depth + ',"budget":' + $Limit + ',"truncated":false,"rootName":"fixture","filterName":"","filterId":"' + $ElId + '","found":true,"dpiAware":"per-monitor-v2"}'
  }
} else {
  $json = '{"ok":false,"error":"fixture bridge does not implement ' + $Command + '"}'
}
[System.IO.File]::WriteAllText($Out, $json)