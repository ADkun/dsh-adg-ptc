# A bridge that dies the way the real one died. TEST FIXTURE -- the CLI never points at this file.
#
# Measured on this machine (2026-10-05): a UIA content read raised
#   System.AccessViolationException
#     at MS.Internal.Automation.UiaCoreApi.RawTextRange_GetText(SafeTextRangeHandle, Int32, String&)
#     at System.Windows.Automation.Text.TextPatternRange.GetText(Int32)
# and PowerShell's try/catch could NOT catch it: the whole powershell.exe vanished with
# exit=3221225477 (STATUS_ACCESS_VIOLATION / 0xC0000005) before it could write the -Out file.
#
# `exit -1073741819` is the spelling that reproduces that exit code. `exit 3221225477` does NOT:
# PowerShell's exit parameter is [int], so the literal overflows to 0 (both measured).
#
# Used by desktop/test/content-safety.test.mjs to prove that the channel layer turns a dead child
# into {ok:false, exitCode} instead of an exception, and that the caller then reports
# CHANGED=unknown -- never the lie CHANGED=false.
exit -1073741819