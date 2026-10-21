# desktop/scripts/identity.ps1 -- the ONE implementation of the element identity check (design.md I6f).
#
# Why this is a separate file: the acting path is scripts/bridge.ps1 (Do-InvokeChosen), but a test that
# only *reads* bridge.ps1 can tell "some text is there" and nothing more -- it cannot separate a gate
# that works from one whose condition was neutered. So the decision lives here exactly once, bridge.ps1
# dot-sources it, and test/fixtures/invoke-identity-bridge.ps1 dot-sources the SAME file: whatever an
# executing test exercises is literally the code the real bridge runs.
#
# Counting the hits happens on the caller's locating snapshot; the acting happens on a SECOND walk of
# the tree, and the only thing that travels between the two is $ElId -- a hash of the runtime id. A
# hash match therefore does not prove it is the same element (the placeholder id el_unknown is the
# extreme case: every element whose GetRuntimeId() fails carries that one id), so when the caller sends
# the identity, a mismatch means the bridge refuses to act at all.
#
# ASCII-only and no BOM: the host decodes a BOM-less script with the system ANSI code page (see the
# bridge.ps1 header), so a non-ASCII byte here would be mangled for the host itself. Non-ASCII text
# only ever travels in and out as JSON string data.

function Get-ElementIdentityGate {
  param([string]$Expected = '', [string]$Actual = '', [string]$ElementId = '')
  # Empty $Expected = "the caller had no identity to send": old behaviour, no check at all.
  if ($Expected -eq '') { return $null }
  if ($Actual -eq $Expected) { return $null }
  # A mismatch is neither an error nor a failure to act: it is a REFUSAL to touch the element, so no
  # pattern is fetched and no action primitive runs. bridge.ps1 writes this report verbatim; the Node
  # side turns it into exit code 2 (refused to act), which is not the same thing as 1 (acted, no
  # observable change).
  return [ordered]@{
    ok = $true
    invoked = $false
    elementId = $ElementId
    identityMismatch = $true
    runtimeIdExpected = $Expected
    runtimeIdActual = $Actual
    patternError = 'element identity mismatch: id matched but runtimeId differs'
  }
}