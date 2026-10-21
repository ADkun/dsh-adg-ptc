# desktop/scripts/bridge.ps1 -- native bridge for the desktop CLI.
#
# Contract (do not change without changing desktop/design.md):
#   Host  : Windows PowerShell 5.1 (%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe)
#   Invoke: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bridge.ps1
#             -Command <profile|screen|windows|uia|point|input|verify|snapshot|probe> -Out <json> [options]
#   Output: exactly one JSON object, UTF-8 without BOM, written to -Out. The caller reads that
#           file; stdout/stderr are diagnostics only.
#           Success: {"ok":true,...}   Failure: {"ok":false,"error":"<message>"} + exit 1
#   Exit  : 0 ran (look at "ok"), 1 error / bad arguments
#
# Why a file and not stdout: under the DSH restricted-token sandbox a child process cannot own
# the libuv named pipe that `spawn(..., {stdio:'pipe'})` needs (EPERM), so the Node side must
# capture output through a file handle. Writing the payload ourselves with UTF-8 (no BOM) also
# keeps non-ASCII window titles intact -- 5.1 would otherwise encode them as ANSI.
#
# Why this file is ASCII-only and has no BOM: both hosts decode a BOM-less script with the
# system ANSI code page. Any non-ASCII byte written here would be mangled for the host itself.
# Non-ASCII text only ever travels in and out as JSON string data.
#
# Safety boundary (mirrors desktop/design.md I9): this bridge never elevates, never touches the
# secure desktop (Winlogon / UAC consent), never injects into another process, never changes a
# system setting. It reads window/UI state and synthesizes input with SendInput only.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Command,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Hwnd = '',
  [string]$X = '',
  [string]$Y = '',
  [string]$Region = '',
  [string]$Shot = '',
  [switch]$Hash,
  [int]$Depth = 8,
  [string]$Name = '',
  [string]$ElId = '',
  # Optional element IDENTITY, handed down by the caller next to $ElId (design.md I6f).
  # $ElId is only a hash of the runtime id, and the hit is decided by a SECOND walk of the tree --
  # so an id match alone does not prove it is the same element (every element whose GetRuntimeId()
  # fails collapses into the placeholder id el_unknown). When this is non-empty the matched node's
  # runtime id must equal it character for character, otherwise NO action is taken at all.
  # Empty means "the caller had no identity to send" (that is the old behaviour, unchanged).
  [string]$ElRuntimeId = '',
  [string]$SetValue = '',
  [string]$Button = 'left',
  [switch]$Double,
  [string]$Text = '',
  [string]$Keys = '',
  [int]$Clicks = 0,
  [int]$WheelDelta = 0,
  [int]$Limit = 3000,
  [switch]$NoMove,
  # Move the pointer and NOTHING else. Without this the mouse branch below always appends a
  # down/up pair (because $Button defaults to 'left'), so `move` used to click as well -- and the
  # JS side's hand-written dry-run plan said 1 event while the real path sent 3. Found by making
  # the plan come from this one construction path instead of being recomputed in JS.
  [switch]$MoveOnly,
  [switch]$PlanOnly,
  [switch]$Raise,
  [switch]$Invoke
)

$ErrorActionPreference = 'Stop'

# The element identity check lives in its own file so that exactly ONE implementation exists: this
# acting path and test/fixtures/invoke-identity-bridge.ps1 (the executing test) dot-source the same
# file, so neutering the decision turns that test red instead of staying invisible behind a source
# scan. ASCII-only, no BOM, LF-only -- same rules as this script.
. (Join-Path $PSScriptRoot 'identity.ps1')

# ---------------------------------------------------------------------------
# DPI awareness FIRST, before any coordinate is read: a non-DPI-aware host gets
# a virtualized screen size (measured on this machine: 1707x1067 instead of
# 2560x1600 on a 150% display), which would silently invalidate every
# coordinate this bridge hands out or accepts. Declared per process, no
# elevation required, no manifest needed.
# ---------------------------------------------------------------------------
$script:DpiMode = 'none'

function Add-NativeTypes {
  if ('DesktopBridge.Native' -as [type]) { return }
  $code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace DesktopBridge {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  // The union members are declared FLAT on INPUT, not as a nested INPUTUNION field, because
  // PowerShell hands out a COPY for a member of a NESTED value type: `$item.u.mi.dx = ..` writes
  // into a throwaway PSObject and the structure marshals out all zeroes while SendInput still
  // reports "N events inserted". Fields declared directly on the outer struct do persist.
  // Do NOT "tidy this up" back into a nested union; INPUTUNION stays declared as documentation.
  //
  // Every offset below is the real Win32 layout, derived from the winuser.h definitions and then
  // verified byte-for-byte against the canonical nested-union struct (CANONICAL_INPUT) by `probe`:
  //
  //   INPUT { DWORD type; union { MOUSEINPUT mi; KEYBDINPUT ki; HARDWAREINPUT hi; } u; }
  //   MOUSEINPUT holds a ULONG_PTR, so the union has 8-byte alignment and starts at offset 8;
  //   it is 32 bytes wide, giving sizeof(INPUT) = 40.
  //
  //   MOUSEINPUT (32 bytes)      internal -> INPUT
  //       dx 0 -> 8 | dy 4 -> 12 | mouseData 8 -> 16 | dwFlags 12 -> 20 | time 16 -> 24
  //       pad 20..23 | dwExtraInfo 24 -> 32
  //   KEYBDINPUT (24 bytes)
  //       wVk 0 -> 8 | wScan 2 -> 10 | dwFlags 4 -> 12 | time 8 -> 16
  //       pad 12..15 | dwExtraInfo 16 -> 24        <-- NOT 32: the keyboard tail is 8 bytes shorter
  //   HARDWAREINPUT (8 bytes)
  //       uMsg 0 -> 16 | wParamL 4 -> 20 | wParamH 6 -> 22
  //
  // The consequence that matters: mouse dwFlags lands on absolute 20 while keyboard dwFlags lands
  // on absolute 12, and the two dwExtraInfo fields land on 32 vs 24. One shared field per name
  // cannot serve both devices. A dropped KEYEVENTF_UNICODE (bit 2) makes SendInput report success
  // while no character ever reaches the target, so the split mouse*/key* fields below are
  // load-bearing. Hence too the rule that follows: only the C# factories may write these fields.
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT {
    [FieldOffset(0)] public uint type;
    // MOUSEINPUT view
    [FieldOffset(8)] public int dx;
    [FieldOffset(12)] public int dy;
    [FieldOffset(16)] public uint mouseData;
    [FieldOffset(20)] public uint mouseFlags;
    [FieldOffset(24)] public uint mouseTime;
    [FieldOffset(32)] public IntPtr mouseExtraInfo;
    // KEYBDINPUT view -- dwFlags is at 12, NOT at 20 where the mouse flags live
    [FieldOffset(8)] public ushort wVk;
    [FieldOffset(10)] public ushort wScan;
    [FieldOffset(12)] public uint keyFlags;
    [FieldOffset(16)] public uint keyTime;
    [FieldOffset(24)] public IntPtr keyExtraInfo;
    // HARDWAREINPUT view
    [FieldOffset(16)] public uint uMsg;
    [FieldOffset(20)] public ushort wParamL;
    [FieldOffset(22)] public ushort wParamH;
  }

  // The canonical definition, kept as a NESTED union exactly as winuser.h declares it. Nothing
  // injects through it -- PowerShell cannot write a nested member -- but the marshaller can build
  // it, so `probe` uses it as the reference layout that the flat INPUT must reproduce
  // byte-for-byte. If someone "fixes" an offset above, this comparison is what catches it.
  [StructLayout(LayoutKind.Explicit)]
  public struct CANONICAL_UNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct CANONICAL_INPUT {
    public uint type;
    public CANONICAL_UNION u;
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  // Field offsets, in one place, so the docs, the factories and the probe all quote the same
  // numbers. Values are byte offsets inside INPUT (see the comment above the struct).
  public static class InputLayout {
    public const int Type = 0;
    public const int MouseDx = 8;
    public const int MouseDy = 12;
    public const int MouseData = 16;
    public const int MouseFlags = 20;
    public const int MouseTime = 24;
    public const int KeyVk = 8;
    public const int KeyScan = 10;
    public const int KeyFlags = 12;
    public const int KeyTime = 16;
    public const int MouseExtraInfo = 32;
    public const int KeyExtraInfo = 24;
    public const int StructSize = 40;
  }

  public static class Native {
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int limit);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int limit);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr hWnd, int index);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, byte[] name, ref uint size);
  // Used only to turn a lone punctuation character into a virtual key for chords (`ctrl+/`):
  // VkKeyScanW is layout aware, while a hard-coded punctuation table would not be.
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char ch);

    // Factories for the two event kinds. Building the struct in C# -- instead of assigning fields
    // from PowerShell -- is what makes a wrong offset impossible to ship silently: the field
    // names are checked by the C# compiler here, and the result is verified byte-for-byte by
    // `probe` plus test/injection.test.mjs.
    public static INPUT NewMouseInput(int nx, int ny, uint flags, uint mouseData) {
      INPUT item = new INPUT();
      item.type = 0;                       // INPUT_MOUSE
      item.dx = nx;
      item.dy = ny;
      item.mouseData = mouseData;
      item.mouseFlags = flags;             // absolute 20 = MOUSEINPUT.dwFlags
      item.mouseTime = 0;
      item.mouseExtraInfo = IntPtr.Zero;   // absolute 32 = MOUSEINPUT.dwExtraInfo
      return item;
    }

    public static INPUT NewKeyboardInput(ushort vk, ushort scan, uint flags) {
      INPUT item = new INPUT();
      item.type = 1;                       // INPUT_KEYBOARD
      item.wVk = vk;                       // absolute 8  = KEYBDINPUT.wVk
      item.wScan = scan;                   // absolute 10 = KEYBDINPUT.wScan
      item.keyFlags = flags;               // absolute 12 = KEYBDINPUT.dwFlags (mouse flags sit on 20)
      item.keyTime = 0;                    // absolute 16 = KEYBDINPUT.time
      item.keyExtraInfo = IntPtr.Zero;     // absolute 24 = KEYBDINPUT.dwExtraInfo (mouse tail is 32)
      return item;
    }

    // Reference builders: same two events, built through the nested union the way winuser.h
    // declares it. Used only by `probe`, to prove the flat offsets byte-for-byte.
    public static CANONICAL_INPUT CanonicalMouseInput(int nx, int ny, uint flags, uint mouseData) {
      CANONICAL_INPUT item = new CANONICAL_INPUT();
      item.type = 0;
      item.u.mi.dx = nx;
      item.u.mi.dy = ny;
      item.u.mi.mouseData = mouseData;
      item.u.mi.dwFlags = flags;
      item.u.mi.time = 0;
      item.u.mi.dwExtraInfo = IntPtr.Zero;
      return item;
    }

    public static CANONICAL_INPUT CanonicalKeyboardInput(ushort vk, ushort scan, uint flags) {
      CANONICAL_INPUT item = new CANONICAL_INPUT();
      item.type = 1;
      item.u.ki.wVk = vk;
      item.u.ki.wScan = scan;
      item.u.ki.dwFlags = flags;
      item.u.ki.time = 0;
      item.u.ki.dwExtraInfo = IntPtr.Zero;
      return item;
    }
  }

  public static class Dwm {
    [DllImport("dwmapi.dll", PreserveSig = true)] public static extern int DwmGetWindowAttribute(IntPtr hWnd, uint attribute, out int value, int size);
  }

  public static class Advapi {
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, ref IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int infoLength, ref int returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  }
}
'@
  Add-Type -TypeDefinition $code -Language CSharp | Out-Null
  Add-Type -AssemblyName WindowsBase | Out-Null
}

function Initialize-Dpi {
  Add-NativeTypes
  $applied = ''
  try {
    if ([DesktopBridge.Native]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
      $applied = 'PER_MONITOR_AWARE_V2'
    }
  } catch { $applied = '' }
  if ($applied -eq '') {
    try {
      if ([DesktopBridge.Native]::SetProcessDPIAware()) { $applied = 'SYSTEM_AWARE' }
    } catch { $applied = '' }
  }
  if ($applied -eq '') { $applied = 'NONE' }
  $script:DpiMode = $applied
}

function Get-ScreenInfo {
  return [ordered]@{
    width = [DesktopBridge.Native]::GetSystemMetrics(0)
    height = [DesktopBridge.Native]::GetSystemMetrics(1)
    virtualLeft = [DesktopBridge.Native]::GetSystemMetrics(76)
    virtualTop = [DesktopBridge.Native]::GetSystemMetrics(77)
    virtualWidth = [DesktopBridge.Native]::GetSystemMetrics(78)
    virtualHeight = [DesktopBridge.Native]::GetSystemMetrics(79)
    monitorCount = [DesktopBridge.Native]::GetSystemMetrics(80)
    dpiAware = $script:DpiMode
  }
}

function Get-InjectedPath {
  try {
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'bridge.ps1'))
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash) -replace '-', '').Substring(0, 12).ToLower()
  } catch { return 'unknown' }
}

function Get-WindowEntry {
  param([IntPtr]$H, [bool]$WithIntegrity = $true)
  if ($H -eq [IntPtr]::Zero) { return $null }
  $pid32 = [uint32]0
  [void][DesktopBridge.Native]::GetWindowThreadProcessId($H, [ref]$pid32)
  $titleBuf = New-Object System.Text.StringBuilder 512
  [void][DesktopBridge.Native]::GetWindowTextW($H, $titleBuf, 512)
  $classBuf = New-Object System.Text.StringBuilder 512
  [void][DesktopBridge.Native]::GetClassNameW($H, $classBuf, 512)
  $rect = New-Object DesktopBridge.RECT
  [void][DesktopBridge.Native]::GetWindowRect($H, [ref]$rect)
  $entry = [ordered]@{
    hwnd = ('0x{0:x}' -f $H.ToInt64())
    pid = [int]$pid32
    process = Get-ProcessName -ProcessId ([int]$pid32)
    class = $classBuf.ToString()
    title = $titleBuf.ToString()
    left = $rect.Left
    top = $rect.Top
    width = ($rect.Right - $rect.Left)
    height = ($rect.Bottom - $rect.Top)
    minimized = [DesktopBridge.Native]::IsIconic($H)
  }
  if ($WithIntegrity) { $entry['integrity'] = Get-IntegrityLevel -ProcessId ([int]$pid32) }
  return $entry
}

# Process name for a window's owning process.
#
# Get-Process is NOT usable here: measured inside the DSH sandbox (restricted token + Low
# integrity) it fails for every PID, because the managed cmdlet asks for access this token
# does not have. QueryFullProcessImageNameW with PROCESS_QUERY_LIMITED_INFORMATION works from
# the same token, so that is the primary path and Get-Process is only the fallback.
function Get-ProcessName {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return 'unknown' }
  if ($null -eq $script:ProcessNameCache) { $script:ProcessNameCache = @{} }
  $key = [string]$ProcessId
  if ($script:ProcessNameCache.ContainsKey($key)) { return $script:ProcessNameCache[$key] }
  $name = 'unknown'
  $handle = [DesktopBridge.Native]::OpenProcess(0x1000, $false, [uint32]$ProcessId)
  if ($handle -ne [IntPtr]::Zero) {
    try {
      # Byte buffer instead of StringBuilder: the StringBuilder overload silently kept only the
      # first character here, which showed up as process names like "C" and "D".
      $buffer = New-Object byte[] 1040
      $size = [uint32]$buffer.Length
      if ([DesktopBridge.Native]::QueryFullProcessImageNameW($handle, 0, $buffer, [ref]$size)) {
        $full = [System.Text.Encoding]::Unicode.GetString($buffer, 0, [int]$size * 2)
        if ($full -ne '') { $name = [System.IO.Path]::GetFileNameWithoutExtension($full) }
      }
    } catch {
      $name = 'unknown'
    } finally {
      [void][DesktopBridge.Native]::CloseHandle($handle)
    }
  }
  if ($name -eq 'unknown') {
    try {
      $p = Get-Process -Id $ProcessId -ErrorAction Stop
      if ($p.ProcessName) { $name = $p.ProcessName }
    } catch {
      $name = 'unknown'
    }
  }
  $script:ProcessNameCache[$key] = $name
  return $name
}

# Integrity level of the *token* of the process owning the window. The restricted token we run
# under can still query its own token and the tokens of same-or-lower processes; when the query
# fails the answer is 'unknown' (never a guess, and never treated as "reachable" by the caller).
function Get-IntegrityLevel {
  param([int]$ProcessId)
  $rid = 0
  $name = Read-IntegrityLevel -ProcessId $ProcessId -Rid ([ref]$rid)
  if ($name -eq 'unknown' -and $rid -ne 0) { return "unknown(rid=$rid)" }
  return $name
}

# Returns the mapped name; the raw last-sub-authority RID comes back through $Rid.
function Read-IntegrityLevel {
  param([int]$ProcessId, [ref]$Rid)
  $Rid.Value = 0
  if ($ProcessId -le 0) { return 'unknown' }
  $handle = [DesktopBridge.Native]::OpenProcess(0x1000, $false, [uint32]$ProcessId)  # PROCESS_QUERY_LIMITED_INFORMATION
  if ($handle -eq [IntPtr]::Zero) { return 'unknown' }
  try {
    $token = [IntPtr]::Zero
    $desired = 0x0008  # TOKEN_QUERY
    $opened = [DesktopBridge.Advapi]::OpenProcessToken($handle, $desired, [ref]$token)
    if (-not $opened -or $token -eq [IntPtr]::Zero) { return 'unknown' }
    try {
      $size = 0
      [void][DesktopBridge.Advapi]::GetTokenInformation($token, 25, [IntPtr]::Zero, 0, [ref]$size)  # TokenIntegrityLevel
      if ($size -le 0) { return 'unknown' }
      $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
      try {
        if (-not [DesktopBridge.Advapi]::GetTokenInformation($token, 25, $buffer, $size, [ref]$size)) { return 'unknown' }
        $sidPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($buffer)
        if ($sidPtr -eq [IntPtr]::Zero) { return 'unknown' }
        $count = [int][System.Runtime.InteropServices.Marshal]::ReadByte($sidPtr, 1)
        if ($count -lt 1) { return 'unknown' }
        $lastRid = [System.Runtime.InteropServices.Marshal]::ReadInt32($sidPtr, 8 + (($count - 1) * 4))
        $Rid.Value = $lastRid
        return (Convert-RidToName -Rid $lastRid)
      } finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
      }
    } finally {
      [void][DesktopBridge.Advapi]::CloseHandle($token)
    }
  } finally {
    [void][DesktopBridge.Native]::CloseHandle($handle)
  }
}

function Convert-RidToName {
  param([int]$Rid)
  switch ($Rid) {
    0 { return 'untrusted' }
    4096 { return 'low' }
    8192 { return 'medium' }
    12288 { return 'high' }
    16384 { return 'system' }
    20480 { return 'protected' }
    default { return "unknown(rid=$Rid)" }
  }
}

function Get-OurIntegrity {
  return (Get-IntegrityLevel -ProcessId ([System.Diagnostics.Process]::GetCurrentProcess().Id))
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
function Test-ScreenshotAvailable {
  # Real probe, not a constant: System.Drawing ships with .NET Framework, but a stripped or
  # headless-ish image could lack it, and then `screen` fails at runtime. Asking for the
  # assembly type here is the same thing `screen` needs, so the answer means something.
  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    [void][System.Drawing.Bitmap]
    return $true
  } catch {
    return $false
  }
}

function Test-UiaAvailable {
  # Same idea for UIAutomationClient: `uia` cannot work without it.
  # WindowsBase is loaded too: [System.Windows.Point] lives there, and FromPoint() needs one.
  # Without it `New-Object System.Windows.Point(x,y)` throws, so the point-scoped content reading
  # silently disappeared from the snapshot (found by printing the reading list, not by reading).
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    try { Add-Type -AssemblyName WindowsBase -ErrorAction Stop } catch { }
    [void][System.Windows.Automation.AutomationElement]
    return $true
  } catch {
    return $false
  }
}

function Invoke-ProfileCommand {
  Write-Report ([ordered]@{
    ok = $true
    injected = (Get-InjectedPath)
    dpiAware = $script:DpiMode
    screen = Get-ScreenInfo
    ourIntegrity = Get-OurIntegrity
    powershell = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    osVersion = [System.Environment]::OSVersion.VersionString
    uiaAvailable = (Test-UiaAvailable)
    screenshotAvailable = (Test-ScreenshotAvailable)
  })
}

function Invoke-ScreenCommand {
  $screen = Get-ScreenInfo
  $box = $null
  if ($Region -ne '') {
    $parts = $Region.Split(',')
    if ($parts.Count -ne 4) { Fail 'Region must be left,top,width,height'; return }
    $box = [ordered]@{
      left = [int]$parts[0]; top = [int]$parts[1]; width = [int]$parts[2]; height = [int]$parts[3]
      requested = $Region
      clamped = $false
    }
    $minLeft = $screen.virtualLeft
    $minTop = $screen.virtualTop
    $maxRight = $screen.virtualLeft + $screen.virtualWidth
    $maxBottom = $screen.virtualTop + $screen.virtualHeight
    $newLeft = [Math]::Max($box.left, $minLeft)
    $newTop = [Math]::Max($box.top, $minTop)
    $newRight = [Math]::Min($box.left + $box.width, $maxRight)
    $newBottom = [Math]::Min($box.top + $box.height, $maxBottom)
    if ($newLeft -ne $box.left -or $newTop -ne $box.top -or $newRight -ne ($box.left + $box.width) -or $newBottom -ne ($box.top + $box.height)) {
      $box.clamped = $true
    }
    $box.left = $newLeft; $box.top = $newTop
    $box.width = [Math]::Max($newRight - $newLeft, 1); $box.height = [Math]::Max($newBottom - $newTop, 1)
  } else {
    $box = [ordered]@{
      left = $screen.virtualLeft; top = $screen.virtualTop
      width = $screen.virtualWidth; height = $screen.virtualHeight
      requested = 'full'; clamped = $false
    }
  }
  Add-Type -AssemblyName System.Drawing
  $bitmap = New-Object System.Drawing.Bitmap $box.width, $box.height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($box.left, $box.top, 0, 0, (New-Object System.Drawing.Size $box.width, $box.height), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    $stream.Dispose()
    if ($Shot -ne '') { [System.IO.File]::WriteAllBytes($Shot, $bytes) }
    $hashText = ''
    # Must be a [switch]: a [string] parameter with an empty default makes PowerShell reject the
    # bare `-Hash` the Node side sends for a `true` value ("Missing an argument for parameter
    # 'Hash'"), so `screen --hash` failed before it ever took a screenshot.
    if ($Hash) {
      $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
      $hashText = ([System.BitConverter]::ToString($sha) -replace '-', '').Substring(0, 16).ToLower()
    }
    Write-Report ([ordered]@{
      ok = $true
      shot = $Shot
      width = $box.width
      height = $box.height
      left = $box.left
      top = $box.top
      clamped = $box.clamped
      requested = $box.requested
      bytes = $bytes.Length
      hash = $hashText
      screen = $screen
      dpiAware = $script:DpiMode
    })
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Invoke-WindowsCommand {
  Add-NativeTypes
  $found = New-Object System.Collections.ArrayList
  $callback = [DesktopBridge.EnumWindowsProc] {
    param([IntPtr]$h, [IntPtr]$param)
    if (-not [DesktopBridge.Native]::IsWindowVisible($h)) { return $true }
    $exStyle = [DesktopBridge.Native]::GetWindowLongW($h, -20)  # GWL_EXSTYLE
    if (($exStyle -band 0x00000080) -ne 0) { return $true }    # WS_EX_TOOLWINDOW
    $rect = New-Object DesktopBridge.RECT
    if (-not [DesktopBridge.Native]::GetWindowRect($h, [ref]$rect)) { return $true }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { return $true }
    # Skip DWM-cloaked windows (UWP shells park a full-screen invisible window here).
    $cloaked = 0
    try { [void][DesktopBridge.Dwm]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4) } catch { $cloaked = 0 }
    if ($cloaked -ne 0) { return $true }
    $entry = Get-WindowEntry -H $h
    if ($entry -ne $null) { [void]$found.Add($entry) }
    return $true
  }
  [void][DesktopBridge.Native]::EnumWindows($callback, [IntPtr]::Zero)
  $foreground = [DesktopBridge.Native]::GetForegroundWindow()
  $titleBuf = New-Object System.Text.StringBuilder 512
  [void][DesktopBridge.Native]::GetWindowTextW($foreground, $titleBuf, 512)
  Write-Report ([ordered]@{
    ok = $true
    windows = @($found)
    count = $found.Count
    foreground = ('0x{0:x}' -f $foreground.ToInt64())
    foregroundTitle = $titleBuf.ToString()
    screen = Get-ScreenInfo
    ourIntegrity = Get-OurIntegrity
    dpiAware = $script:DpiMode
  })
}

function Get-PatternNames {
  param($Element)
  $names = New-Object System.Collections.ArrayList
  foreach ($pair in @(
      @('InvokePattern', [System.Windows.Automation.InvokePattern]::Pattern),
      @('ValuePattern', [System.Windows.Automation.ValuePattern]::Pattern),
      @('TogglePattern', [System.Windows.Automation.TogglePattern]::Pattern),
      @('SelectionItemPattern', [System.Windows.Automation.SelectionItemPattern]::Pattern),
      @('ExpandCollapsePattern', [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
      @('ScrollItemPattern', [System.Windows.Automation.ScrollItemPattern]::Pattern),
      @('TextPattern', [System.Windows.Automation.TextPattern]::Pattern),
      @('WindowPattern', [System.Windows.Automation.WindowPattern]::Pattern),
      @('RangeValuePattern', [System.Windows.Automation.RangeValuePattern]::Pattern),
      @('SelectionPattern', [System.Windows.Automation.SelectionPattern]::Pattern)
    )) {
    try {
      $obj = $null
      if ($Element.TryGetCurrentPattern($pair[1], [ref]$obj)) { [void]$names.Add($pair[0]) }
    } catch { }
  }
  # The comma matters: `return @($names)` gets unrolled by the pipeline when the list holds
  # exactly ONE pattern, and the caller then receives a bare String. That turned
  # {"patterns":"InvokePattern"} into a scalar in the JSON, which made both patternsText() and
  # chooseAction() see "no patterns" -- so `invoke --id` refused every element that supports
  # exactly one pattern, i.e. exactly the buttons worth clicking.
  return ,@($names)
}

function New-Node {
  param($Element, [int]$Level)
  $node = [ordered]@{}
  try {
    $runtime = $Element.GetRuntimeId()
    $joined = ($runtime | ForEach-Object { [string]$_ }) -join '.'
    $node['id'] = 'el_' + (Get-Fnv1a -Text $joined)
    $node['runtimeId'] = $joined
  } catch {
    # Never invent an id: if the runtime id is unreadable the element gets the placeholder,
    # and the reason is carried out so it cannot be mistaken for a real answer.
    $node['id'] = 'el_unknown'
    $node['runtimeId'] = ''
    $node['idError'] = $_.Exception.Message
  }
  $node['name'] = ''
  $node['automationId'] = ''
  $node['className'] = ''
  $node['controlType'] = ''
  $node['rect'] = $null
  $node['patterns'] = @()
  $node['level'] = $Level
  try { $node['name'] = [string]$Element.Current.Name } catch { }
  try { $node['automationId'] = [string]$Element.Current.AutomationId } catch { }
  try { $node['className'] = [string]$Element.Current.ClassName } catch { }
  try { $node['controlType'] = ([string]$Element.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', '' } catch { }
  try {
    $r = $Element.Current.BoundingRectangle
    if (-not [double]::IsNaN($r.X) -and $r.Width -gt 0) {
      $node['rect'] = [ordered]@{
        left = [int][Math]::Floor($r.X); top = [int][Math]::Floor($r.Y)
        width = [int][Math]::Ceiling($r.Width); height = [int][Math]::Ceiling($r.Height)
      }
    }
  } catch { }
  # `[object[]](Get-PatternNames ...)` WITHOUT the @() wrapper. Both halves matter under Windows
  # PowerShell 5.1, and the difference is measured, not guessed:
  #   [object[]]@(Get-PatternNames -Element $e)  ->  patterns:[["InvokePattern"]]   (nested!)
  #   [object[]](Get-PatternNames -Element $e)   ->  patterns:["InvokePattern"]     (correct)
  # `@(...)` over a function that already returned `,@(...)` keeps the inner array as ONE element,
  # so the JSON came out double-nested, patternList() saw a non-string and returned [], and
  # `invoke --id` refused every single-pattern element. Only ONE wrapping is allowed in the whole
  # chain: the comma inside Get-PatternNames. test/injection.test.mjs pins the JSON shape.
  $node['patterns'] = [object[]](Get-PatternNames -Element $Element)
  return $node
}

# Hash used for the stable element id. Must stay identical to lib/elements.mjs fnv1a32():
# FNV-1a 32-bit over the UTF-8 bytes of the runtime-id string, 8 lowercase hex digits.
#
# Do the arithmetic in [long]: PowerShell widens [uint32] * [uint32] to double, which both
# loses precision and makes `[uint32]` casts throw "too large for a UInt32". Masking with
# 0xFFFFFFFFL on a signed 64-bit value reproduces the uint32 wraparound exactly.
function Get-Fnv1a {
  param([string]$Text)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  [long]$hash = 2166136261
  foreach ($b in $bytes) {
    $hash = $hash -bxor [long]$b
    $hash = ($hash * [long]16777619) -band 0xFFFFFFFFL
  }
  return ('{0:x8}' -f [uint32]$hash)
}

function Get-UiaRoot {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  try {
    $hwndValue = [int64]::Parse($Hwnd.Replace('0x', ''), 'HexNumber')
    return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwndValue)
  } catch {
    return [System.Windows.Automation.AutomationElement]::RootElement
  }
}

function Invoke-UiaCommand {
  $root = Get-UiaRoot
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  # Traversal budget. `--limit` used to cap only what was PRINTED, while the walk itself always
  # stopped at 3000 elements -- so `uia --limit 5` printed 5 of a truncated 3000-element snapshot
  # and `invoke` on a busy desktop could never reach its target. Now the flag caps the walk, and
  # `truncated` (which the CLI prints) is honest about it.
  $budget = 3000
  if ($Limit -gt 0) { $budget = $Limit }
  $nodes = New-Object System.Collections.ArrayList
  $matchName = $Name
  $matchId = $ElId
  if ($matchId -ne '') { $matchName = '' }
  Find-Nodes -Root $root -Walker $walker -Nodes $nodes -Budget $budget -MaxDepth $Depth -MatchId $matchId -MatchName $matchName
  $rootName = ''
  try { $rootName = [string]$root.Current.Name } catch { }
  # The window's own Win32 rectangle next to the root element's UIA rectangle: when those two
  # disagree, every child rectangle in this listing may be in a different coordinate space and
  # must not be used to derive click coordinates (design.md I2b).
  $geo = $null
  if ($Hwnd -ne '') { $geo = Get-GeoCheck -Hwnd ([IntPtr][int64]$Hwnd) }
  if ($Invoke) {
    Do-InvokeChosen -Nodes $nodes -MatchId $matchId -ElRuntimeId $ElRuntimeId -SetValue $SetValue -Budget $budget -Found $nodes.Count
    return
  }
  Write-Report ([ordered]@{
    ok = $true
    elements = @($nodes)
    count = $nodes.Count
    depth = $Depth
    budget = $budget
    truncated = ($nodes.Count -ge $budget)
    rootName = $rootName
    filterName = $matchName
    filterId = $matchId
    found = ($null -ne $script:foundMatch)
    geo = $geo
    dpiAware = $script:DpiMode
  })
}

# Walk the UIA tree. $MatchId is only used to remember the hit in $script:foundMatch;
# printing is still filtered by $MatchName.
function Find-Nodes {
  param($Root, $Walker, $Nodes, [int]$Budget, [int]$MaxDepth, [string]$MatchId, [string]$MatchName)
  $stack = New-Object System.Collections.Stack
  $stack.Push(@{ el = $Root; level = 0 })
  while ($stack.Count -gt 0) {
    if ($Nodes.Count -ge $Budget) { return }
    $item = $stack.Pop()
    $element = $item.el
    $level = $item.level
    $node = New-Node -Element $element -Level $level
    if ($MatchId -ne '' -and $node['id'] -eq $MatchId -and $null -eq $script:foundMatch) {
      $script:foundMatch = @{ node = $node; element = $element }
    }
    $keep = $true
    if ($MatchName -ne '') {
      $needle = $MatchName.ToLower()
      $hay = (([string]$node['name']) + ' ' + ([string]$node['automationId'])).ToLower()
      if ($hay.IndexOf($needle) -lt 0) { $keep = $false }
    }
    if ($keep) { [void]$Nodes.Add($node) }
    if ($level -ge $MaxDepth) { continue }
    $child = $null
    try { $child = $Walker.GetFirstChild($element) } catch { $child = $null }
    while ($null -ne $child) {
      $stack.Push(@{ el = $child; level = ($level + 1) })
      $next = $null
      try { $next = $Walker.GetNextSibling($child) } catch { $next = $null }
      $child = $next
    }
  }
}

# Act through the element's OWN UIA pattern. If it has none, report it -- never guess and
# never degrade into a coordinate click (the degradation path is the caller's
# --fallback-point decision, made explicitly in Node).
function Do-InvokeChosen {
  param($Nodes, [string]$MatchId, [string]$ElRuntimeId = '', [string]$SetValue, [int]$Budget = 3000, [int]$Found = 0)
  if ($MatchId -eq '') {
    Write-Report ([ordered]@{ ok = $true; invoked = $false; patternError = 'invoke requires --id <el_id>' })
    return
  }
  $hit = $script:foundMatch
  if ($null -eq $hit) {
    # "not in the snapshot" and "does not exist" are NOT the same statement. On a busy desktop a
    # root-scoped walk hits the budget long before it reaches the target window, and the old text
    # ("the element may have disappeared") sent the reader looking for the wrong cause -- a real
    # invocation failed 11/11 times that way while the scoped snapshot still listed the element.
    # So report the scope facts, and let the Node side phrase the remedy.
    Write-Report ([ordered]@{
      ok = $true; invoked = $false
      patternError = "snapshot has no element with id $MatchId"
      snapshotCount = $Found
      snapshotBudget = $Budget
      snapshotTruncated = ($Found -ge $Budget)
    })
    return
  }
  $element = $hit.element
  $node = $hit.node
  # Identity gate (design.md I6f): it runs before EVERY action primitive on this path, and before the
  # first pattern fetched IN ORDER TO ACT. It is NOT "before the first TryGetCurrentPattern in this
  # file": building the node records -- here and while a snapshot is built -- only ENUMERATES patterns
  # read-only through Get-PatternNames, which is a listing and not an action. What must not happen is
  # touching the element for the purpose of acting once the identity does not match.
  # The decision is NOT written here: scripts/identity.ps1 holds the single implementation, and the
  # executing test (test/fixtures/invoke-identity-bridge.ps1) dot-sources that same file.
  $identityGate = Get-ElementIdentityGate -Expected $ElRuntimeId -Actual ([string]$node['runtimeId']) -ElementId $MatchId
  if ($null -ne $identityGate) {
    Write-Report $identityGate
    return
  }
  $valueBefore = ''
  $valueAfter = ''
  if ($SetValue -ne '') {
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      # Two different situations land here, so say both: the element never had ValuePattern, or it
      # advertised one in an earlier `uia` snapshot but will not hand it over now (a read-only
      # ValuePattern still answers TryGetCurrentPattern, so a plain "not supported" would be a lie).
      Write-Report ([ordered]@{
        ok = $true; invoked = $false; elementId = $MatchId; patterns = $node['patterns']
        patternError = 'ValuePattern is not obtainable from this element right now (it may be read-only, or the earlier `uia` snapshot may be stale)'
      })
      return
    }
    try { $valueBefore = [string]$pattern.Current.Value } catch { $valueBefore = '' }
    try {
      $pattern.SetValue($SetValue)
      try { $valueAfter = [string]$pattern.Current.Value } catch { $valueAfter = '' }
      Write-Report ([ordered]@{
        ok = $true; invoked = $true; elementId = $MatchId; pattern = 'ValuePattern'
        valueBefore = $valueBefore; valueAfter = $valueAfter; patterns = $node['patterns']
      })
    } catch {
      Write-Report ([ordered]@{
        ok = $true; invoked = $false; elementId = $MatchId; pattern = 'ValuePattern'
        valueBefore = $valueBefore; patterns = $node['patterns']
        patternError = "ValuePattern.SetValue threw: $($_.Exception.Message)"
      })
    }
    return
  }
  $candidates = @(
    @('InvokePattern', [System.Windows.Automation.InvokePattern]::Pattern),
    @('TogglePattern', [System.Windows.Automation.TogglePattern]::Pattern),
    @('SelectionItemPattern', [System.Windows.Automation.SelectionItemPattern]::Pattern),
    @('ExpandCollapsePattern', [System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  )
  foreach ($pair in $candidates) {
    $pattern = $null
    if (-not $element.TryGetCurrentPattern($pair[1], [ref]$pattern)) { continue }
    try {
      if ($pair[0] -eq 'InvokePattern') { $pattern.Invoke() }
      elseif ($pair[0] -eq 'TogglePattern') { $pattern.Toggle() }
      elseif ($pair[0] -eq 'SelectionItemPattern') { $pattern.Select() }
      else {
        $state = $pattern.Current.ExpandCollapseState
        if ("$state" -eq 'Collapsed') { $pattern.Expand() } else { $pattern.Collapse() }
      }
      Write-Report ([ordered]@{
        ok = $true; invoked = $true; elementId = $MatchId; pattern = $pair[0]
        valueBefore = $valueBefore; valueAfter = $valueAfter; patterns = $node['patterns']
      })
      return
    } catch {
      Write-Report ([ordered]@{
        ok = $true; invoked = $false; elementId = $MatchId; pattern = $pair[0]
        patterns = $node['patterns']
        patternError = "$($pair[0]) threw: $($_.Exception.Message)"
      })
      return
    }
  }
  Write-Report ([ordered]@{
    ok = $true; invoked = $false; elementId = $MatchId; patterns = $node['patterns']
    patternError = 'element has no usable semantic pattern (Invoke/Toggle/SelectionItem/ExpandCollapse)'
  })
}

function Get-GeoCheck {
  # Geometry self-consistency. Paid for with a real miss (design.md I2b), not with theory.
  #
  # Measured: with the target window MAXIMIZED, `windows` reported -11,-11,2582,1550 while `uia`
  # handed back a SECOND set of rectangles matching the app's own client layout; a click derived
  # from the uia numbers landed on a different control (ELEMENT_TYPE=Edit) and did nothing at all.
  # Two independent readings of "where is this window / this element" must corroborate each other
  # before a coordinate-based injection is allowed to go out.
  #
  # Both checks below are *property* reads only -- same POLICY as Read-ElementContent: no UIA
  # method that asks a provider to hand back text or geometry.
  param([IntPtr]$Hwnd = [IntPtr]::Zero, [int]$Px = -1, [int]$Py = -1, [int]$Tolerance = 2)
  Add-NativeTypes
  $result = [ordered]@{
    hwnd = ''
    rootHwnd = ''
    winRect = ''
    uiaRootRect = ''
    rootRectMatches = $null
    pointRect = ''
    pointInElementRect = $null
    tolerance = $Tolerance
    note = ''
  }
  if ($Hwnd -eq [IntPtr]::Zero) {
    $result.note = 'no window handle'
    return $result
  }
  $root = [DesktopBridge.Native]::GetAncestor($Hwnd, 2)   # GA_ROOT
  if ($root -eq [IntPtr]::Zero) { $root = $Hwnd }
  $result.hwnd = ('0x{0:x}' -f $Hwnd.ToInt64())
  $result.rootHwnd = ('0x{0:x}' -f $root.ToInt64())
  $rect = New-Object DesktopBridge.RECT
  if ([DesktopBridge.Native]::GetWindowRect($root, [ref]$rect)) {
    $result.winRect = ('{0},{1},{2},{3}' -f $rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
  }
  $errors = New-Object System.Collections.ArrayList
  if (-not (Test-UiaAvailable)) {
    [void]$errors.Add('UIA unavailable')
    $result.note = ($errors -join '; ')
    return $result
  }
  $uiaRoot = $null
  try { $uiaRoot = [System.Windows.Automation.AutomationElement]::FromHandle($root) } catch { [void]$errors.Add("root:$($_.Exception.Message)") }
  if ($null -ne $uiaRoot) {
    try {
      $r = $uiaRoot.Current.BoundingRectangle
      if (-not [double]::IsNaN($r.X) -and $r.Width -gt 0 -and $r.Height -gt 0) {
        $result.uiaRootRect = ('{0},{1},{2},{3}' -f [int][Math]::Floor($r.X), [int][Math]::Floor($r.Y), [int][Math]::Ceiling($r.Width), [int][Math]::Ceiling($r.Height))
      }
    } catch { [void]$errors.Add("rootRect:$($_.Exception.Message)") }
  }
  if ($result.winRect -ne '' -and $result.uiaRootRect -ne '') {
    $a = @(($result.winRect -split ',') | ForEach-Object { [int]$_ })
    $b = @(($result.uiaRootRect -split ',') | ForEach-Object { [int]$_ })
    $same = $true
    for ($i = 0; $i -lt 4; $i++) {
      if ([Math]::Abs($a[$i] - $b[$i]) -gt $Tolerance) { $same = $false }
    }
    $result.rootRectMatches = $same
  }
  if ($Px -ge 0 -and $Py -ge 0) {
    try {
      $pt = New-Object System.Windows.Point($Px, $Py)
      $hit = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
      if ($null -ne $hit) {
        $r2 = $hit.Current.BoundingRectangle
        if (-not [double]::IsNaN($r2.X) -and $r2.Width -gt 0 -and $r2.Height -gt 0) {
          $l = [int][Math]::Floor($r2.X)
          $t = [int][Math]::Floor($r2.Y)
          $w = [int][Math]::Ceiling($r2.Width)
          $h = [int][Math]::Ceiling($r2.Height)
          $result.pointRect = ('{0},{1},{2},{3}' -f $l, $t, $w, $h)
          # Does the element under the requested pixel claim to sit there? If its own rectangle does
          # not contain the pixel, the provider's coordinates are in a different space than the
          # physical pixels -- which is exactly the state that made a click miss.
          $result.pointInElementRect = (($Px -ge ($l - $Tolerance)) -and ($Px -le ($l + $w + $Tolerance)) -and ($Py -ge ($t - $Tolerance)) -and ($Py -le ($t + $h + $Tolerance)))
        }
      }
    } catch { [void]$errors.Add("pointRect:$($_.Exception.Message)") }
  }
  $result.note = ($errors -join '; ')
  return $result
}

function Invoke-PointCommand {
  Add-NativeTypes
  $screen = Get-ScreenInfo
  $px = [int]$X
  $py = [int]$Y
  $point = New-Object DesktopBridge.POINT
  $point.X = $px
  $point.Y = $py
  $hwnd = [DesktopBridge.Native]::WindowFromPoint($point)
  # WindowFromPoint hands back the deepest child window (e.g. Chrome_RenderWidgetHostHWND),
  # which has no title and no useful class. Walk up to GA_ROOT so the report is about the
  # top-level window the user sees.
  # NOTE: RealChildWindowFromPoint() used to be called here to keep a "leaf" handle for
  # reference. It was removed because (a) nothing consumed that field, and (b) pt has to be
  # in the *parent window's client* coordinates -- passing screen coordinates only produced
  # coincidentally-right answers. See design.md I7g for the measured semantics.
  $root = [DesktopBridge.Native]::GetAncestor($hwnd, 2)  # GA_ROOT
  $reportHwnd = $hwnd
  if ($root -ne [IntPtr]::Zero) { $reportHwnd = $root }
  $window = Get-WindowEntry -H $reportHwnd
  $element = $null
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $hit = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point $px, $py))
    if ($null -ne $hit) {
      $element = [ordered]@{
        name = [string]$hit.Current.Name
        automationId = [string]$hit.Current.AutomationId
        controlType = ([string]$hit.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
        # Same one-wrapping rule as New-Node: cast, never wrap in @().
        patterns = [object[]](Get-PatternNames -Element $hit)
      }
      $runtime = $hit.GetRuntimeId()
      $element['id'] = 'el_' + (Get-Fnv1a -Text (($runtime | ForEach-Object { [string]$_ }) -join '.'))
    }
  } catch { $element = $null }
  $inside = ($px -ge $screen.virtualLeft -and $px -lt ($screen.virtualLeft + $screen.virtualWidth) -and $py -ge $screen.virtualTop -and $py -lt ($screen.virtualTop + $screen.virtualHeight))
  $hwndText = ''
  if ($hwnd -ne [IntPtr]::Zero) { $hwndText = '0x{0:x}' -f $hwnd.ToInt64() }
  $rootText = ''
  if ($root -ne [IntPtr]::Zero) { $rootText = '0x{0:x}' -f $root.ToInt64() }
  Write-Report ([ordered]@{
    ok = $true
    x = $px
    y = $py
    insideVirtualScreen = $inside
    hwnd = $hwndText
    rootHwnd = $rootText
    window = $window
    element = $element
    geo = (Get-GeoCheck -Hwnd $reportHwnd -Px $px -Py $py)
    screen = $screen
    ourIntegrity = Get-OurIntegrity
    dpiAware = $script:DpiMode
  })
}

function New-MouseInput {
  param([int]$Px, [int]$Py, [uint32]$Flags, [uint32]$Data)
  $screen = Invoke-ScreenMetricsRaw
  $nx = 0
  $ny = 0
  if ($screen.virtualWidth -gt 1 -and $screen.virtualHeight -gt 1) {
    $nx = [int][Math]::Round((($Px - $screen.virtualLeft) * 65535.0) / ($screen.virtualWidth - 1))
    $ny = [int][Math]::Round((($Py - $screen.virtualTop) * 65535.0) / ($screen.virtualHeight - 1))
  }
  $nx = [Math]::Max(0, [Math]::Min(65535, $nx))
  $ny = [Math]::Max(0, [Math]::Min(65535, $ny))
  # Build one mouse event. The struct is filled in by the C# factory (Native.NewMouseInput); this
  # function only does the pixel -> 0..65535 normalisation and hands back the raw struct plus the
  # numbers it used. It must NOT assign any INPUT field from PowerShell: those writes go into a
  # copy, and the silently-zeroed result still makes SendInput report "N events inserted".
  $item = [DesktopBridge.Native]::NewMouseInput($nx, $ny, $Flags, [uint32]$Data)
  return @{ input = $item; nx = $nx; ny = $ny }
}

function Invoke-ScreenMetricsRaw {
  Add-NativeTypes
  return [ordered]@{
    virtualLeft = [DesktopBridge.Native]::GetSystemMetrics(76)
    virtualTop = [DesktopBridge.Native]::GetSystemMetrics(77)
    virtualWidth = [DesktopBridge.Native]::GetSystemMetrics(78)
    virtualHeight = [DesktopBridge.Native]::GetSystemMetrics(79)
  }
}

function New-KeyInput {
  param([uint16]$VirtualKey, [uint16]$Scan, [uint32]$Flags, [bool]$Up)
  Add-NativeTypes
  $effectiveFlags = $Flags
  if ($Up) { $effectiveFlags = $Flags -bor 2 }   # KEYEVENTF_KEYUP
  # Same rule as New-MouseInput: C# fills the struct. Keyboard dwFlags lives at FIELD OFFSET 12
  # (union byte 4), NOT at 20 where the mouse flags live -- assigning a shared field name from
  # PowerShell is exactly how KEYEVENTF_UNICODE got dropped and every `type`/`key` became a no-op.
  return [DesktopBridge.Native]::NewKeyboardInput($VirtualKey, $Scan, $effectiveFlags)
}

# Regression for the defect that made every injection a silent no-op: PowerShell hands out a
# COPY for a member of a nested value type, so `$item.u.mi.dx = 42` was written into a temporary
# that got thrown away -- the struct went out all zeroes and SendInput still reported
# "N events inserted". Static review cannot see this: the assignment LOOKS right and the field
# reads back as 0 only if you look. So this command builds one mouse and one keyboard event,
# marshals them exactly like Send-Inputs does, and returns the raw bytes for the test to assert
# against. It never calls SendInput.
function Invoke-ProbeCommand {
  Add-NativeTypes
  # One DOWN and one UP keyboard event, so the byte assertions can pin both KEYEVENTF_UNICODE (4)
  # and KEYEVENTF_KEYUP (2) at their real offsets. Vk 65 = 'A'.
  $mi = New-MouseInput -Px 100 -Py 100 -Flags 0xC001 -Data 0
  $kDown = New-KeyInput -VirtualKey 0 -Scan 65 -Flags 4 -Up $false
  $kUp = New-KeyInput -VirtualKey 0 -Scan 65 -Flags 4 -Up $true
  # A wheel event for the NEGATIVE direction (-3 clicks), using the exact same conversion the
  # scroll path uses. -360 has to reach MOUSEINPUT.mouseData as the uint32 0xFFFFFEA8; the old code
  # assigned the signed value straight into a [uint32] parameter and the whole command died with
  # "Cannot convert value "-360" to type "System.UInt32"" before any event was built.
  $wheelDw = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32](-3 * 120)), 0)
  $wheel = (New-MouseInput -Px 100 -Py 100 -Flags 0x0800 -Data $wheelDw).input
  $mouse = $mi.input
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DesktopBridge.INPUT])
  $mouseBytes = Get-StructBytes -Value $mouse -Size $size
  $keyBytes = Get-StructBytes -Value $kDown -Size $size
  $keyUpBytes = Get-StructBytes -Value $kUp -Size $size
  $wheelBytes = Get-StructBytes -Value $wheel -Size $size
  # Reference: the same two events built through the nested union exactly as winuser.h declares it.
  # The flat struct above must marshal to the identical bytes, otherwise its offsets are wrong --
  # this is the check that static review cannot do and that the field reads cannot do either.
  $canonSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DesktopBridge.CANONICAL_INPUT])
  $canonMouseBytes = Get-StructBytes -Value ([DesktopBridge.Native]::CanonicalMouseInput(2561, 4098, 0xC001, 0)) -Size $canonSize
  $canonKeyBytes = Get-StructBytes -Value ([DesktopBridge.Native]::CanonicalKeyboardInput(0, 65, 4)) -Size $canonSize
  $canonKeyUpBytes = Get-StructBytes -Value ([DesktopBridge.Native]::CanonicalKeyboardInput(0, 65, 6)) -Size $canonSize
  $canonWheelBytes = Get-StructBytes -Value ([DesktopBridge.Native]::CanonicalMouseInput(2561, 4098, 0x0800, $wheelDw)) -Size $canonSize
  Write-Report ([ordered]@{
    ok = $true
    inputStructSize = $size
    canonicalStructSize = $canonSize
    mouseInputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DesktopBridge.MOUSEINPUT])
    keyInputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DesktopBridge.KEYBDINPUT])
    mouseBytesHex = (($mouseBytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
    keyBytesHex = (($keyBytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
    keyUpBytesHex = (($keyUpBytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
    canonicalMouseBytesHex = (($canonMouseBytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
    canonicalKeyBytesHex = (($canonKeyBytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
    canonicalKeyUpBytesHex = (($canonKeyUpBytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
    wheelBytesHex = (($wheelBytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
    canonicalWheelBytesHex = (($canonWheelBytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
    wheelMatchesCanonical = (@(Compare-Object $wheelBytes $canonWheelBytes -SyncWindow 0).Count -eq 0)
    wheelClicks = -3
    wheelDwData = [BitConverter]::ToInt32([BitConverter]::GetBytes($wheelDw), 0)
    mouseMatchesCanonical = (@(Compare-Object $mouseBytes $canonMouseBytes -SyncWindow 0).Count -eq 0)
    keyMatchesCanonical = (@(Compare-Object $keyBytes $canonKeyBytes -SyncWindow 0).Count -eq 0)
    keyUpMatchesCanonical = (@(Compare-Object $keyUpBytes $canonKeyUpBytes -SyncWindow 0).Count -eq 0)
    wheelFields = [ordered]@{ type = $wheel.type; dx = $wheel.dx; dy = $wheel.dy; flags = $wheel.mouseFlags; mouseData = $wheel.mouseData }
    mouseHex = (($mouseBytes | Select-Object -First 24 | ForEach-Object { '{0:x2}' -f $_ }) -join ' ')
    keyHex = (($keyBytes | Select-Object -First 24 | ForEach-Object { '{0:x2}' -f $_ }) -join ' ')
    mouseFields = [ordered]@{ type = $mouse.type; dx = $mouse.dx; dy = $mouse.dy; flags = $mouse.mouseFlags; mouseData = $mouse.mouseData }
    keyFields = [ordered]@{ type = $kDown.type; wVk = $kDown.wVk; wScan = $kDown.wScan; flags = $kDown.keyFlags }
    # The offsets the assertions use, straight from the C# constants -- so a test failure can say
    # which number moved instead of hard-coding one in two places.
    offsets = [ordered]@{
      type = [DesktopBridge.InputLayout]::Type
      mouseDx = [DesktopBridge.InputLayout]::MouseDx
      mouseDy = [DesktopBridge.InputLayout]::MouseDy
      mouseData = [DesktopBridge.InputLayout]::MouseData
      mouseFlags = [DesktopBridge.InputLayout]::MouseFlags
      mouseTime = [DesktopBridge.InputLayout]::MouseTime
      mouseExtraInfo = [DesktopBridge.InputLayout]::MouseExtraInfo
      keyVk = [DesktopBridge.InputLayout]::KeyVk
      keyScan = [DesktopBridge.InputLayout]::KeyScan
      keyFlags = [DesktopBridge.InputLayout]::KeyFlags
      keyTime = [DesktopBridge.InputLayout]::KeyTime
      keyExtraInfo = [DesktopBridge.InputLayout]::KeyExtraInfo
    }
  })
}

# Marshal a struct into a byte[] exactly the way Send-Inputs hands it to SendInput.
# Note: on this host the 3-arg Marshal::StructureToPtr overload cannot be bound from
# PowerShell ("Cannot find an overload for StructureToPtr and the argument count: 3"), so we
# marshal into an HGlobal buffer and copy the bytes out. Same marshaller, same field layout.
function Get-StructBytes {
  param([object]$Value, [int]$Size)
  $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($Size)
  try {
    [System.Runtime.InteropServices.Marshal]::StructureToPtr($Value, $ptr, $false)
    $bytes = New-Object byte[] $Size
    [System.Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $Size)
    return $bytes
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
  }
}

# LastError is thread-local and is NOT reset by a successful call, so it has to be sampled
# immediately after SendInput returns -- any other native call in between (GetCursorPos,
# Add-Type bookkeeping) can leave a stale code behind (measured: 203 / ERROR_ENVVAR_NOT_FOUND
# on a call that reported 3 inserted events).
function Send-Inputs {
  param([object[]]$Inputs)
  if ($Inputs.Count -eq 0) { return @{ inserted = 0; lastError = 0 } }
  $array = New-Object 'DesktopBridge.INPUT[]' $Inputs.Count
  for ($i = 0; $i -lt $Inputs.Count; $i++) { $array[$i] = $Inputs[$i] }
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DesktopBridge.INPUT])
  $inserted = [int][DesktopBridge.Native]::SendInput([uint32]$Inputs.Count, $array, $size)
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  return @{ inserted = $inserted; lastError = $err }
}

# Read the cursor back from the OS. This is the only hardware-level proof that a MOVE actually
# landed: SendInput can report success while the pointer never moves, which is exactly the
# "false success" this module refuses to emit.
function Get-CursorPoint {
  Add-NativeTypes
  $point = New-Object DesktopBridge.POINT
  if ([DesktopBridge.Native]::GetCursorPos([ref]$point)) {
    return @{ x = $point.X; y = $point.Y; ok = $true }
  }
  return @{ x = 0; y = 0; ok = $false }
}

# Bring the target window to the top of the z-order before injecting.
#
# Why: an injected click lands on whatever window is topmost at that pixel. A background
# process cannot use SetForegroundWindow (Windows refuses the request -- measured), but
# SetWindowPos with HWND_TOPMOST works. This DOES change the user's z-order, so it is opt-in
# (--raise) and the CLI only asks for it when the point is covered by another window.
function Raise-Window {
  param([IntPtr]$Hwnd)
  if ($Hwnd -eq [IntPtr]::Zero) { return $false }
  Add-NativeTypes
  # HWND_TOPMOST = -1, SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW = 0x0002|0x0001|0x0040
  return [DesktopBridge.Native]::SetWindowPos($Hwnd, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0043)
}

function Get-InjectionTarget {
  param([int]$Px, [int]$Py)
  Add-NativeTypes
  $point = New-Object DesktopBridge.POINT
  $point.X = $Px
  $point.Y = $Py
  $hwnd = [DesktopBridge.Native]::WindowFromPoint($point)
  $root = [DesktopBridge.Native]::GetAncestor($hwnd, 2)  # GA_ROOT: report the top-level window
  $reportHwnd = $hwnd
  if ($root -ne [IntPtr]::Zero) { $reportHwnd = $root }
  $window = Get-WindowEntry -H $reportHwnd
  return [ordered]@{
    hwnd = $window.hwnd
    pid = $window.pid; process = $window.process; title = $window.title
    class = $window.class; integrity = $window.integrity
  }
}

# Make sure the window that will receive synthesized keystrokes is actually in the foreground.
#
# Keyboard events carry no coordinates: SendInput delivers them to whatever window has focus, so a
# background target silently swallows every character. SetForegroundWindow from a background
# process is refused by Windows unless our thread is attached to the foreground thread's input
# queue, so attach -> raise -> SetForegroundWindow -> detach is the working sequence (verified by
# the E2E run against a real WinForms window).
#
# Fail-closed: if the target is still not in the foreground after the retry, the caller must NOT
# send keys. Reporting "3 events inserted" while the characters land nowhere is exactly the silent
# no-op this module exists to refuse.
function Focus-WindowForKeyboard {
  param([IntPtr]$Target)
  Add-NativeTypes
  $before = [DesktopBridge.Native]::GetForegroundWindow()
  $same = ($before -eq $Target)
  $result = [ordered]@{
    target = ('0x{0:x}' -f $Target.ToInt64())
    foregroundBefore = ('0x{0:x}' -f $before.ToInt64())
    foregroundAfter = ('0x{0:x}' -f $before.ToInt64())
    alreadyForeground = $same
    attempted = $false
    ok = $same
  }
  if ($same) {
    $result['foregroundTitle'] = (Get-WindowEntry -H $Target -WithIntegrity $false).title
    return $result
  }
  $result['attempted'] = $true
  $targetThread = [uint32]0
  [void][DesktopBridge.Native]::GetWindowThreadProcessId($Target, [ref]$targetThread)
  $foreThread = [uint32]0
  if ($before -ne [IntPtr]::Zero) { [void][DesktopBridge.Native]::GetWindowThreadProcessId($before, [ref]$foreThread) }
  $ourThread = [DesktopBridge.Native]::GetCurrentThreadId()
  $attachedFore = $false
  $attachedTarget = $false
  try {
    if ($ourThread -ne $foreThread) { $attachedFore = [DesktopBridge.Native]::AttachThreadInput($ourThread, $foreThread, $true) }
    if ($targetThread -ne 0 -and $targetThread -ne $ourThread) { $attachedTarget = [DesktopBridge.Native]::AttachThreadInput($ourThread, $targetThread, $true) }
    [void][DesktopBridge.Native]::BringWindowToTop($Target)
    [void][DesktopBridge.Native]::SetForegroundWindow($Target)
  } finally {
    if ($attachedTarget) { [void][DesktopBridge.Native]::AttachThreadInput($ourThread, $targetThread, $false) }
    if ($attachedFore) { [void][DesktopBridge.Native]::AttachThreadInput($ourThread, $foreThread, $false) }
  }
  Start-Sleep -Milliseconds 80
  $after = [DesktopBridge.Native]::GetForegroundWindow()
  $result['foregroundAfter'] = ('0x{0:x}' -f $after.ToInt64())
  $result['ok'] = ($after -eq $Target)
  $result['foregroundTitle'] = (Get-WindowEntry -H $after -WithIntegrity $false).title
  return $result
}

function Invoke-InputCommand {
  # PowerShell variable names are CASE-INSENSITIVE, so a local `$clicks` silently shadows the
  # `$Clicks` parameter: `$clicks = 1` made the very next `if ($Clicks -gt 0)` read that 1 right
  # back, which collapsed both --double and --clicks N into ONE click. Measured on real hardware:
  # `click --x 431 --y 280 --double --force` reported INSERTED_EVENTS=3 CLICKS=1 and the target's
  # DoubleClick handler never fired, while the dry-run plan claimed 5 events. Copy every parameter
  # this function needs into a distinctly named local FIRST, and never assign to a name that
  # differs from a parameter only by case.
  $wantedClicks = [int]$Clicks
  $wantsDouble = [bool]$Double
  # Which window the keys would go to, decided ONCE before any branch: --hwnd, else the window
  # under --x/--y, else whatever happens to be in the foreground. The real path below reads this
  # same variable, so the dry-run plan and the real run cannot drift apart (design.md I10b) -- and
  # "keys went to the foreground window because nobody named a target" becomes visible in the plan
  # instead of only in the aftermath.
  $keyboardFocusSource = 'foreground'
  if ($Hwnd -ne '') { $keyboardFocusSource = 'hwnd' }
  elseif ($X -ne '' -and $Y -ne '') { $keyboardFocusSource = 'point' }
  $screen = Get-ScreenInfo
  $targetX = [int]$X
  $targetY = [int]$Y
  $plan = [ordered]@{}
  $inputs = New-Object System.Collections.ArrayList
  if ($Text -ne '') {
    foreach ($ch in $Text.ToCharArray()) {
      $code = [uint16][int][char]$ch
      [void]$inputs.Add((New-KeyInput -VirtualKey 0 -Scan $code -Flags 4 -Up $false))
      [void]$inputs.Add((New-KeyInput -VirtualKey 0 -Scan $code -Flags 4 -Up $true))
    }
    $plan['kind'] = 'text'
    $plan['characters'] = $Text.Length
    $plan['virtualKeys'] = @()
    $plan['focusSource'] = $keyboardFocusSource
    $plan['focusTarget'] = $Hwnd
  } elseif ($Keys -ne '') {
    $specs = Parse-KeySpec -Spec $Keys
    # Parse-KeySpec fails closed on an unmappable or unknown token: it records the error and
    # returns nothing, so an empty list means "stop here with that message", never "send nothing".
    if (@($specs).Count -eq 0) { return }
    $plan['kind'] = 'key'
    $plan['steps'] = @($specs | ForEach-Object { $_.name })
    $plan['focusSource'] = $keyboardFocusSource
    $plan['focusTarget'] = $Hwnd
    # Descriptors are built once and used for BOTH the plan and the injection. Before this, the
    # plan only echoed the user's spelling (`KEYS=ctrl+a`), so a chord that was silently sent as a
    # bare Unicode character looked perfect in `--dry-run` and did nothing on the target.
    # The ordered sequence (with its PHASE column) comes from ConvertTo-KeySequence: a chord must
    # hold its modifiers down around the payload key, not tap them. See that function for the real
    # target reading that proves the difference.
    $keyEvents = @(ConvertTo-KeySequence -Specs $specs)
    $plan['keys'] = $keyEvents
    foreach ($event in $keyEvents) {
      $isUp = ($event.phase -eq 'key-up' -or $event.phase -eq 'modifier-up')
      [void]$inputs.Add((New-KeyInput -VirtualKey $event.vk -Scan $event.scan -Flags $event.flags -Up $isUp))
    }
  } else {
    if ($X -eq '' -or $Y -eq '') { Fail 'input requires --x/--y (mouse) or --text/--keys'; return }
    $plan['kind'] = 'mouse'
    $move = New-MouseInput -Px $targetX -Py $targetY -Flags 0xC001 -Data 0  # ABSOLUTE | VIRTUALDESK | MOVE
    $plan['absolute'] = @{ x = $targetX; y = $targetY }
    $plan['normalized'] = @{ dx = $move.nx; dy = $move.ny; virtualLeft = $screen.virtualLeft; virtualTop = $screen.virtualTop; virtualWidth = $screen.virtualWidth; virtualHeight = $screen.virtualHeight }
    if ($WheelDelta -ne 0) {
      # WHEEL is relative by definition: the move above only positions the pointer, then dwData
      # carries the signed notch count. -3 notches is -360, which overflows UInt32 -- reinterpret
      # the signed product's bit pattern as unsigned instead of casting the negative value.
      # The flags/data go in through the factory; there must be no `$wheelItem.dwFlags = ..`
      # afterwards, because that write lands in a PowerShell copy of the struct and vanishes.
      $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]($WheelDelta * 120)), 0)
      $wheelItem = New-MouseInput -Px $targetX -Py $targetY -Flags 0x0800 -Data $wheelData  # MOUSEEVENTF_WHEEL
      [void]$inputs.Add($move.input)
      [void]$inputs.Add($wheelItem.input)
      $plan['wheel'] = @{ clicks = $WheelDelta; dwData = ($WheelDelta * 120); relative = $true }
    } elseif ($MoveOnly) {
      # Pointer only. A `move` command that also pressed and released a button would be a click in
      # disguise -- exactly what the old JS-side plan hid.
      [void]$inputs.Add($move.input)
      $plan['button'] = ''
      $plan['clicks'] = 0
      $plan['double'] = $false
    } else {
      $flags = [uint32]0
      $upFlags = [uint32]0
      if ($Button -eq 'right') { $flags = 0x0008; $upFlags = 0x0010 }
      elseif ($Button -eq 'middle') { $flags = 0x0020; $upFlags = 0x0040 }
      else { $flags = 0x0002; $upFlags = 0x0004 }
      $down = New-MouseInput -Px $targetX -Py $targetY -Flags (0xC001 -bor $flags) -Data 0
      $up = New-MouseInput -Px $targetX -Py $targetY -Flags (0xC001 -bor $upFlags) -Data 0
      [void]$inputs.Add($move.input)
      # NOTE: never name this local `$clicks` -- see the case-insensitivity note at the top of
      # this function. $wantedClicks / $wantsDouble were captured before any local assignment.
      $clickCount = 1
      if ($wantedClicks -gt 0) { $clickCount = $wantedClicks }
      elseif ($wantsDouble) { $clickCount = 2 }
      for ($i = 0; $i -lt $clickCount; $i++) {
        [void]$inputs.Add($down.input)
        [void]$inputs.Add($up.input)
      }
      $plan['button'] = $Button
      $plan['clicks'] = $clickCount
      $plan['double'] = $wantsDouble
    }
  }
  if ($PlanOnly) {
    # Planning only: report exactly the same `plan`/`expected` the real path would use, and touch
    # nothing -- no SendInput, no SetForegroundWindow, no Raise-Window, no AttachThreadInput.
    # This is what makes "the dry-run plan equals what a real run does" an assertable invariant
    # instead of a second, drifting implementation on the JS side.
    Write-Report ([ordered]@{
      ok = $true
      plan = $plan
      expected = $inputs.Count
      planOnly = $true
      target = @{ x = $targetX; y = $targetY }
      ourIntegrity = Get-OurIntegrity
      screen = $screen
      dpiAware = $script:DpiMode
    })
    return
  }
  $targetInfo = $null
  $cursorBefore = Get-CursorPoint
  $raiseResult = $null
  $raiseNote = ''
  $focusResult = $null
  $isKeyboard = ($Text -ne '' -or $Keys -ne '')
  if ($Raise -and $X -ne '' -and $Y -ne '') {
    $probe = Get-InjectionTarget -Px $targetX -Py $targetY
    $raiseResult = @{ target = $probe.hwnd; raised = (Raise-Window -Hwnd ([IntPtr][int64]$probe.hwnd)) }
    Start-Sleep -Milliseconds 120   # let the z-order change settle before the click lands
  } elseif ($Raise -and $Hwnd -ne '') {
    $raiseResult = @{ target = $Hwnd; raised = (Raise-Window -Hwnd ([IntPtr][int64]$Hwnd)) }
    Start-Sleep -Milliseconds 120
  } elseif ($Raise) {
    # --raise only means something for a command that names a window: a mouse command anchors on
    # --x/--y, and a keyboard command on --hwnd. Say so instead of accepting the flag silently.
    # Keep it ASCII: this script must stay parseable by Windows PowerShell 5.1, which decodes a
    # BOM-less file with the ANSI code page -- non-ASCII here breaks the whole script (it did:
    # a Chinese sentence in this very line made every command fail with a parse error).
    $raiseNote = 'raise-ignored-no-target: --raise needs --x/--y (mouse) or --hwnd (keyboard) to name the window to raise; this module will not guess one.'
  }
  if ($X -ne '' -and $Y -ne '') { $targetInfo = Get-InjectionTarget -Px $targetX -Py $targetY }
  if ($isKeyboard) {
    # Keyboard events go to whatever has focus, so the target is --hwnd, else the window under
    # --x/--y, else the current foreground window. The choice itself is made ONCE at the top of
    # this function ($keyboardFocusSource) so the plan and this path can never disagree. Never
    # guess silently: no window at all is an error (nothing would receive the keys), and a target
    # that will not come to the front is an error too -- see Focus-WindowForKeyboard.
    $focusSource = $keyboardFocusSource
    $focusTarget = [IntPtr]::Zero
    if ($keyboardFocusSource -eq 'hwnd') {
      $focusTarget = [IntPtr][int64]$Hwnd
    } elseif ($keyboardFocusSource -eq 'point') {
      $probe = Get-InjectionTarget -Px $targetX -Py $targetY
      $focusTarget = [IntPtr][int64]$probe.hwnd
    } else {
      $focusTarget = [DesktopBridge.Native]::GetForegroundWindow()
    }
    if ($focusTarget -eq [IntPtr]::Zero -or -not [DesktopBridge.Native]::IsWindow($focusTarget)) {
      Write-Report ([ordered]@{ ok = $false; plan = $plan; expected = $inputs.Count; focusSource = $focusSource })
      Fail "keyboard input has no target window: pass --hwnd <0x...> or a coordinate, or give focus to a window first"
      return
    }
    $focusResult = Focus-WindowForKeyboard -Target $focusTarget
    $focusResult['source'] = $focusSource
    if (-not $focusResult.ok) {
      Write-Report ([ordered]@{
        ok = $false
        plan = $plan
        expected = $inputs.Count
        focus = $focusResult
        ourIntegrity = Get-OurIntegrity
      })
      Fail ("keyboard input target is not in the foreground and could not be brought there (target={0}, foreground={1}); no keys were sent" -f $focusResult.target, $focusResult.foregroundAfter)
      return
    }
  }
  # Keyboard focus follows the foreground window; measured 26 characters sent but only 25 landing
  # because the first one was lost while focus was still moving. Give it a moment first, on top of
  # the settle the foreground hand-off already did.
  if ($isKeyboard) { Start-Sleep -Milliseconds 150 }
  $inserted = -1
  $lastError = 0
  if ($NoMove) {
    $sent = Send-Inputs -Inputs @()
  } else {
    $sent = Send-Inputs -Inputs @($inputs)
  }
  $inserted = $sent.inserted
  $lastError = $sent.lastError
  $cursorAfter = Get-CursorPoint
  $cursorMoved = $false
  if ($X -ne '' -and $Y -ne '') {
    $cursorMoved = ($cursorAfter.x -eq $targetX -and $cursorAfter.y -eq $targetY)
  }
  Write-Report ([ordered]@{
    ok = $true
    plan = $plan
    expected = $inputs.Count
    inserted = $inserted
    lastError = $lastError
    target = $targetInfo
    cursorBefore = $cursorBefore
    cursorAfter = $cursorAfter
    cursorLanded = $cursorMoved
    cursorReadbackOk = ($cursorAfter.ok -and $cursorBefore.ok)
    raise = $raiseResult
    raiseNote = $raiseNote
    focus = $focusResult
    ourIntegrity = Get-OurIntegrity
    screen = $screen
    dpiAware = $script:DpiMode
    inputStructSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DesktopBridge.INPUT])
  })
}

# One character -> its virtual key. Letters and digits are plain arithmetic (layout independent);
# anything else goes through VkKeyScanW so punctuation follows the active keyboard layout.
# Returns 0 when this layout cannot type that character as a key.
function Get-CharVirtualKey {
  param([string]$Char)
  if ($Char.Length -ne 1) { return 0 }
  $code = [int][char]$Char
  if ($code -ge 97 -and $code -le 122) { return $code - 32 }   # a-z -> VK_A..VK_Z (0x41..0x5A)
  if ($code -ge 65 -and $code -le 90) { return $code }         # A-Z
  if ($code -ge 48 -and $code -le 57) { return $code }         # 0-9 -> VK_0..VK_9 (0x30..0x39)
  $scan = [DesktopBridge.Native]::VkKeyScan([char]$Char)
  if ($scan -eq -1) { return 0 }
  return ($scan -band 0xFF)
}

# "ctrl+s", "alt+shift+tab", "enter", "a". Returns objects {name, kind, vk|char, path}.
#
# Why a single character inside a chord must NOT take the Unicode route (measured on a real
# target, not inferred): `key --keys ctrl+a` reported `INSERTED_EVENTS=4 EVENTS_MATCH_PLAN=true`,
# yet the target gained exactly one character (`TEXTCHANGED len=2639 -> 2640`) and a following
# `type --text V` appended instead of replacing a selection -- the select-all never happened.
# Reason: KEYEVENTF_UNICODE synthesizes one WM_CHAR directly and bypasses the keyboard state, so
# the Ctrl that was held down is simply ignored. A chord therefore sends its single characters as
# virtual keys (VK_A for "a"), which the target interprets with the modifiers that are really held.
# `type` text and a lone `key a` keep the Unicode route: there the goal is "produce this character
# on any layout", and there is no modifier state to honour.
function Parse-KeySpec {
  param([string]$Spec)
  $named = @{
    'enter' = 13; 'tab' = 9; 'esc' = 27; 'escape' = 27; 'space' = 32; 'backspace' = 8
    'delete' = 46; 'del' = 46; 'up' = 38; 'down' = 40; 'left' = 37; 'right' = 39
    'home' = 36; 'end' = 35; 'pageup' = 33; 'pagedown' = 34; 'insert' = 45
    'f1' = 112; 'f2' = 113; 'f3' = 114; 'f4' = 115; 'f5' = 116; 'f6' = 117
    'f7' = 118; 'f8' = 119; 'f9' = 120; 'f10' = 121; 'f11' = 122; 'f12' = 123
  }
  $mods = @{ 'ctrl' = 17; 'control' = 17; 'alt' = 18; 'shift' = 16; 'win' = 91 }
  # Virtual-key -> the name the user typed. `KEYS=` echoes these step names, and leaking the raw
  # "mod17" made a correct chord look like an internal identifier (measured: `key --keys ctrl+s`
  # printed KEYS=mod17+s).
  $modLabels = @{ 17 = 'ctrl'; 18 = 'alt'; 16 = 'shift'; 91 = 'win' }
  # NOTE: `$out` would shadow the script's `$Out` parameter (PowerShell names are case-insensitive)
  # -- harmless today because this function never reads $Out, but it is the same trap that broke
  # `--clicks`. Use a name that cannot collide.
  $raw = New-Object System.Collections.ArrayList
  $tokens = $Spec.Split('+')
  $modKeys = New-Object System.Collections.ArrayList
  # Pass 1: split the chord and collect its modifiers.
  for ($i = 0; $i -lt $tokens.Count; $i++) {
    $token = $tokens[$i].Trim()
    if ($token -eq '') { continue }
    $lower = $token.ToLower()
    if ($i -lt ($tokens.Count - 1) -and $mods.ContainsKey($lower)) {
      [void]$modKeys.Add($mods[$lower])
      continue
    }
    [void]$raw.Add([ordered]@{ name = $token; lower = $lower })
  }
  # The presence of a modifier is the SINGLE source of truth for how single characters are sent.
  # It is computed once, here, so the two routes can never drift apart (that drift is exactly what
  # let `ctrl+a` look correct in the plan while the target never saw a chord).
  $hasModifier = $modKeys.Count -gt 0
  # Pass 2: classify each token. A single character in a chord goes the virtual-key route; a lone
  # one keeps the Unicode route.
  $specs = New-Object System.Collections.ArrayList
  foreach ($item in $raw) {
    if ($named.ContainsKey($item.lower)) {
      [void]$specs.Add([ordered]@{ name = $item.name; kind = 'virtual'; vk = $named[$item.lower]; path = 'named' })
    } elseif ($item.lower.Length -eq 1) {
      if (-not $hasModifier) {
        # Keep the character exactly as typed: `key A` must produce an upper-case A. The token used
        # to be lower-cased here, so `key --keys A` silently typed `a` (measured on this machine).
        [void]$specs.Add([ordered]@{ name = $item.name; kind = 'char'; char = $item.name; path = 'unicode' })
      } else {
        $vk = Get-CharVirtualKey -Char $item.lower
        if ($vk -eq 0) {
          # Fail closed: sending wScan=0 (what a NUL character becomes) reports success while no
          # key ever reaches the target. Say what is wrong instead.
          Fail ("this character cannot be sent as part of a chord on the active keyboard layout: '$($item.name)'; spell the key out (for example 'ctrl+a'), or send the text with --text")
          return @()
        }
        [void]$specs.Add([ordered]@{ name = $item.name; kind = 'virtual'; vk = $vk; path = 'char-as-vk' })
      }
    } else {
      # Was silently turned into a NUL-scan Unicode event, i.e. a no-op that reported success
      # (`key --keys nosuchkey` planned 2 events). Unknown tokens must not be guessed.
      Fail ("unknown key name: '$($item.name)'; use a single character, a modifier chord such as 'ctrl+a', or one of: enter tab esc space backspace delete up down left right home end pageup pagedown insert f1-f12")
      return @()
    }
  }
  # Modifiers are held down around the final key (emitted as their own press/release pairs by
  # the caller is too coarse for chords, so the caller flattens them: here we return them first).
  $flattened = New-Object System.Collections.ArrayList
  foreach ($mod in $modKeys) {
    $label = 'mod'
    if ($modLabels.ContainsKey($mod)) { $label = $modLabels[$mod] }
    [void]$flattened.Add([ordered]@{ name = $label; kind = 'virtual'; vk = $mod; path = 'modifier' })
  }
  foreach ($item in $specs) { [void]$flattened.Add($item) }
  return @($flattened)
}

# Spec -> one keyboard event descriptor {name, path, vk, scan, flags}. This is the ONLY place that
# turns a parsed spec into (virtual key, scan code, flags): the real injection and the -PlanOnly
# plan both iterate the descriptors, so a plan can never describe something other than what is sent
# (design.md I10b). `flags` 4 = KEYEVENTF_UNICODE, which the Unicode route needs and a chord must
# never use.
function ConvertTo-KeyEvent {
  param([object]$Spec)
  if ($Spec.kind -eq 'virtual') {
    return [ordered]@{ name = $Spec.name; path = $Spec.path; vk = [uint16]$Spec.vk; scan = [uint16]0; flags = [uint16]0 }
  }
  return [ordered]@{ name = $Spec.name; path = 'unicode'; vk = [uint16]0; scan = [uint16][int][char]$Spec.char; flags = [uint16]4 }
}

# Specs -> the ORDERED event list that is really fed to SendInput, every event carrying its PHASE.
#
# A chord needs a real hold. The old loop emitted one down/up pair per descriptor, so `ctrl+a`
# became `ctrl-down ctrl-up a-down a-up`: the modifier was tapped and released *before* the payload
# key, and the target saw a bare `a`. The event count was still 4 and `EVENTS_MATCH_PLAN` was still
# true, so nothing in the output could show it. Measured on a real target (WinForms text box):
# `key --keys ctrl+a` produced one lower-case `a` (`len 2639 -> 2640`) and a following
# `type --text V` appended instead of replacing the selection -- the select-all never happened;
# `ctrl+c` typed a `c`; `shift+a` produced a lower-case `a`.
#
# Shape now: modifiers down in the order they were written, payload key down/up, modifiers up in
# the REVERSE order (last pressed, first released). With no modifiers this degenerates to exactly
# the old per-key down/up order, which `key a`, named keys and `type` text keep.
# Phase values: modifier-down | key-down | key-up | modifier-up.
function ConvertTo-KeySequence {
  param([object[]]$Specs)
  $mods = New-Object System.Collections.ArrayList
  $payload = New-Object System.Collections.ArrayList
  foreach ($spec in $Specs) {
    if ($spec.path -eq 'modifier') { [void]$mods.Add($spec) } else { [void]$payload.Add($spec) }
  }
  $events = New-Object System.Collections.ArrayList
  foreach ($mod in $mods) {
    $event = ConvertTo-KeyEvent -Spec $mod
    $event['phase'] = 'modifier-down'
    [void]$events.Add($event)
  }
  foreach ($spec in $payload) {
    # Down and up are separate dictionaries: they travel as separate INPUT structs, and sharing one
    # object would make a later mutation show up in both.
    $down = ConvertTo-KeyEvent -Spec $spec
    $down['phase'] = 'key-down'
    [void]$events.Add($down)
    $up = ConvertTo-KeyEvent -Spec $spec
    $up['phase'] = 'key-up'
    [void]$events.Add($up)
  }
  for ($i = $mods.Count - 1; $i -ge 0; $i--) {
    $event = ConvertTo-KeyEvent -Spec $mods[$i]
    $event['phase'] = 'modifier-up'
    [void]$events.Add($event)
  }
  return @($events)
}

function Read-ElementContent {
  # A few *content* readings for one element. Every read is individually guarded: an element that
  # does not implement a pattern, or that disappears between two calls, must not abort the whole
  # snapshot -- it just contributes nothing.
  #
  # POLICY -- paid for with a real crash, do not relax it (see design.md I7e):
  #   (a) acquire a pattern with TryGetCurrentPattern, and
  #   (b) read *properties* off the acquired pattern (Current.*).
  #   NEVER call a UIA *method* that asks the provider to hand back text or geometry.
  #   TextPatternRange.GetText / GetBoundingRectangles / TextPattern.GetSelection and friends can
  #   raise a corrupted-state AccessViolationException that PowerShell's try/catch CANNOT catch:
  #   the whole process dies, exit=3221225477 (STATUS_ACCESS_VIOLATION). Measured: a bare
  #   $tp.GetSelection()[0].GetText(-1) killed this bridge on EVERY WinForms TextBox it touched,
  #   empty or not, while DocumentRange.GetText(-1) on the very same element was fine. A
  #   `try { } catch { }` around such a call is NOT protection -- keep the call out of this process
  #   (that is why the content probe now runs as its own child: see Invoke-SnapshotCommand).
  param([object]$Element, [string]$Role)
  $out = New-Object System.Collections.ArrayList
  if ($null -eq $Element) { return @() }
  $name = ''
  $control = ''
  try { $name = [string]$Element.Current.Name } catch { $name = '' }
  try { $control = [string]$Element.Current.ControlType.ProgrammaticName } catch { $control = '' }
  if ($control -eq '') { $control = '-' }
  if ($name -eq '') { $name = '-' }
  # An identity reading is always available (whenever the element itself is) and is worth hashing:
  # "the focused element is now a different control" is a real, observable change. It is NOT a
  # content reading though -- it cannot tell whether the text inside the box changed -- so the two
  # are tagged differently and only `content|` lines count towards contentCount.
  [void]$out.Add("identity|$Role|$control|$name")
  $value = $null
  try {
    $vp = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $value = [string]$vp.Current.Value
    }
  } catch { }
  if ($null -ne $value) { [void]$out.Add("content|$Role|value|$control|$name|$value") }
  # A `selection` reading used to sit here: TextPattern.GetSelection() plus $sel[0].GetText(-1).
  # It is gone on purpose -- that is the call that killed this process on every WinForms TextBox.
  # Read the POLICY block at the top of this function before adding any TextPattern read back.
  try {
    $rv = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$rv)) {
      [void]$out.Add("content|$Role|rangeValue|$control|$name|$($rv.Current.Value)")
    }
  } catch { }
  try {
    $sp = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$sp)) {
      # Scroll percent is what `scroll --dy` moves; pixels alone can miss it entirely.
      [void]$out.Add("content|$Role|scroll|$control|$name|$($sp.Current.VerticalScrollPercent)|$($sp.Current.HorizontalScrollPercent)")
    }
  } catch { }
  try {
    $tg = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tg)) {
      [void]$out.Add("content|$Role|toggle|$control|$name|$($tg.Current.ToggleState)")
    }
  } catch { }
  try {
    $si = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$si)) {
      [void]$out.Add("content|$Role|selected|$control|$name|$($si.Current.IsSelected)")
    }
  } catch { }
  return @($out)
}

function Read-AncestorContent {
  # `scroll --dy` moves the CONTAINER's scroll position, but the element under the cursor is usually
  # the item inside that container (ScrollItem, not ScrollPattern). Measured on a real list: the
  # wheel event moved the scrollbar (independent GetScrollInfo read-back: nMin=0 nMax=79 nPage=5,
  # nPos 0 -> 15 -> 30) while the snapshot saw nothing, because it only ever looked at the element
  # under the cursor. Walking a few control-view parents finds the container that owns the position.
  #
  # Same POLICY as Read-ElementContent (property reads only, no provider text/geometry methods):
  # this reuses Read-ElementContent, it does not add any UIA call of its own beyond GetParent.
  param([object]$Element, [int]$MaxLevels = 3)
  $out = New-Object System.Collections.ArrayList
  if ($null -eq $Element) { return ,@($out) }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $current = $Element
  for ($i = 1; $i -le $MaxLevels; $i++) {
    $parent = $null
    try { $parent = $walker.GetParent($current) } catch { $parent = $null }
    if ($null -eq $parent) { break }
    foreach ($line in (Read-ElementContent -Element $parent -Role "ancestor$i")) {
      # Only content lines: the ancestor's identity is not evidence about this action's effect.
      if ($line.StartsWith('content|')) { [void]$out.Add($line) }
    }
    $current = $parent
  }
  return ,@($out)
}

function Get-ContentSnapshot {
  # WHY THIS EXISTS (measured, not theorised): `type`/`key`/`scroll` all reported CHANGED=false
  # while the target window's own TextChanged log, an independent UIA ValuePattern read-back and
  # the scrollbar's UIA value all agreed the action had landed. The old criteria set (pixel hash +
  # the element name under --x/--y + the window-title set) simply cannot see "the text in this box
  # changed" or "the list scrolled", so a real success looked exactly like a failure. Reading a
  # handful of UIA content properties costs a few calls and closes that hole.
  # When none of the readings can be obtained we return count=0 -- the CLI then prints
  # CHANGED=unknown rather than pretending the action did nothing.
  param([IntPtr]$Root = [IntPtr]::Zero, [int]$Px = -1, [int]$Py = -1)
  if (-not (Test-UiaAvailable)) { return @{ hash = ''; count = 0; contentCount = 0; kinds = [ordered]@{ value = 0; scroll = 0; rangeValue = 0; toggle = 0; selected = 0; ancestorScroll = 0 }; readings = @(); uia = $false; note = 'UIA unavailable' } }
  $readings = New-Object System.Collections.ArrayList
  $script:contentProbeErrors = New-Object System.Collections.ArrayList
  $wanted = New-Object System.Collections.ArrayList
  try { [void]$wanted.Add(@{ role = 'focus'; el = [System.Windows.Automation.AutomationElement]::FocusedElement }) } catch { $script:contentProbeErrors += "focus:$($_.Exception.Message)" }
  if ($Root -ne [IntPtr]::Zero) {
    try { [void]$wanted.Add(@{ role = 'root'; el = [System.Windows.Automation.AutomationElement]::FromHandle($Root) }) } catch { $script:contentProbeErrors += "root:$($_.Exception.Message)" }
  }
  if ($Px -ge 0 -and $Py -ge 0) {
    try {
      $pt = New-Object System.Windows.Point($Px, $Py)
      [void]$wanted.Add(@{ role = 'point'; el = [System.Windows.Automation.AutomationElement]::FromPoint($pt) })
    } catch { $script:contentProbeErrors += "point:$($_.Exception.Message)" }
  }
  $errors = New-Object System.Collections.ArrayList
  foreach ($e in $script:contentProbeErrors) { [void]$errors.Add($e) }
  # Ancestors are walked for ONE element only (the point element when there is one, else the focused
  # element): every wanted element's ancestor chain overlaps the others', so walking all three would
  # triple the cross-process calls and add nothing but duplicate lines.
  $ancestorRole = ''
  foreach ($candidate in @('point', 'focus')) {
    foreach ($item in $wanted) { if ($item.role -eq $candidate) { $ancestorRole = $candidate } }
    if ($ancestorRole -ne '') { break }
  }
  foreach ($item in $wanted) {
    if ($null -eq $item.el) { [void]$errors.Add("$($item.role):element-unavailable"); continue }
    foreach ($r in (Read-ElementContent -Element $item.el -Role $item.role)) { [void]$readings.Add($r) }
    if ($item.role -eq $ancestorRole) {
      foreach ($r in (Read-AncestorContent -Element $item.el -MaxLevels 3)) { [void]$readings.Add($r) }
    }
  }
  $joined = ($readings -join "`n")
  $contentBearing = @($readings | Where-Object { $_.StartsWith('content|') })
  # Per-kind counts. "How many content readings in total" is not enough to judge an action:
  # `scroll` needs a *scroll* reading specifically, and a total count would let an unrelated Value
  # reading masquerade as evidence that the scroll position was observed.
  $kinds = [ordered]@{ value = 0; scroll = 0; rangeValue = 0; toggle = 0; selected = 0; ancestorScroll = 0 }
  foreach ($line in $contentBearing) {
    $parts = $line.Split('|')
    if ($parts.Count -lt 3) { continue }
    $kind = $parts[2]
    if (-not $kinds.Contains($kind)) { continue }
    $kinds[$kind] = $kinds[$kind] + 1
    if ($kind -eq 'scroll' -and $parts[1].StartsWith('ancestor')) { $kinds['ancestorScroll'] = $kinds['ancestorScroll'] + 1 }
  }
  return @{
    hash = (Get-Fnv1a -Text $joined)
    count = @($readings).Count
    contentCount = $contentBearing.Count
    kinds = $kinds
    readings = @($readings)
    uia = $true
    note = ($errors -join '; ')
  }
}

function Invoke-SnapshotCommand {
  # The content probe, alone in its own process ON PURPOSE (design.md I7e).
  #
  # Why it is not part of `verify` any more: the UIA content reads can raise a corrupted-state
  # AccessViolationException that PowerShell cannot catch -- the process disappears with
  # exit=3221225477 before it can write the result file. While the probe lived inside `verify`,
  # that killed the before-snapshot of every injecting command, so `click`/`type`/`key`/`invoke`
  # never even reached SendInput. As its own child, a crash costs exactly one content reading: the
  # caller marks it unknown and keeps going. The command has ZERO side effects -- it never sends
  # input, never raises a window, never changes the foreground.
  #
  # Scope: --hwnd and --x/--y are ADDITIVE, not alternatives (design.md I7h).
  #
  # They used to be if/elseif, and that silently cost the whole point scope: the caller pins the
  # root with --hwnd (so the before/after probes cannot drift apart) AND passes --x/--y (so the
  # element under the point and its 3 ancestors are read). With elseif, any --hwnd erased the point
  # readings; `scroll` then needs a `scroll` reading that structurally no longer existed, so it
  # could never report CHANGED=true. Measured on real hardware (WPF ScrollViewer + 200 TextBlocks):
  # a standalone probe at the point read scroll=1, ancestorScroll=1 while the after-probe of
  # `scroll --x 1620 --y 480 --dy -5` read 0 -- and the target's own log said v=48 -> 96.
  Add-NativeTypes
  $root = [DesktopBridge.Native]::GetForegroundWindow()
  $source = 'foreground'
  $px = -1
  $py = -1
  if ($X -ne '' -and $Y -ne '') {
    $px = [int]$X
    $py = [int]$Y
    $point = New-Object DesktopBridge.POINT
    $point.X = $px
    $point.Y = $py
    $hit = [DesktopBridge.Native]::WindowFromPoint($point)
    if ($hit -ne [IntPtr]::Zero) {
      $root = [DesktopBridge.Native]::GetAncestor($hit, 2)  # GA_ROOT
      $source = 'point'
    }
  }
  if ($Hwnd -ne '') {
    # Explicit target wins for the ROOT (it is what pins before/after together), but it must not
    # cancel the point scope above.
    $root = [IntPtr][int64]$Hwnd
    if ($px -ge 0 -and $py -ge 0) { $source = 'point+hwnd' } else { $source = 'hwnd' }
  }
  $content = Get-ContentSnapshot -Root $root -Px $px -Py $py
  Write-Report ([ordered]@{
    ok = $true
    snapshot = [ordered]@{
      root = ('0x{0:x}' -f $root.ToInt64())
      source = $source
      px = $px
      py = $py
      hash = $content.hash
      count = $content.count
      contentCount = $content.contentCount
      kinds = $content.kinds
      readings = @($content.readings)
      uia = $content.uia
      note = $content.note
    }
  })
}

function Invoke-VerifyCommand {
  Add-NativeTypes
  $fingerprint = [ordered]@{}
  $foreground = [DesktopBridge.Native]::GetForegroundWindow()
  $titleBuf = New-Object System.Text.StringBuilder 512
  [void][DesktopBridge.Native]::GetWindowTextW($foreground, $titleBuf, 512)
  $fingerprint['foreground'] = ('0x{0:x}' -f $foreground.ToInt64())
  $fingerprint['foregroundTitle'] = $titleBuf.ToString()
  if ($X -ne '' -and $Y -ne '') {
    $point = New-Object DesktopBridge.POINT
    $point.X = [int]$X
    $point.Y = [int]$Y
    $hit = [DesktopBridge.Native]::WindowFromPoint($point)
    $fingerprint['point'] = ('0x{0:x}' -f $hit.ToInt64())
    $entry = Get-WindowEntry -H $hit
    $fingerprint['pointTitle'] = $entry.title
    $fingerprint['pointProcess'] = $entry.process
    $fingerprint['pointIntegrity'] = $entry.integrity
  }
  $visible = New-Object System.Collections.ArrayList
  $callback = [DesktopBridge.EnumWindowsProc] {
    param([IntPtr]$h, [IntPtr]$param)
    if (-not [DesktopBridge.Native]::IsWindowVisible($h)) { return $true }
    $exStyle = [DesktopBridge.Native]::GetWindowLongW($h, -20)
    if (($exStyle -band 0x00000080) -ne 0) { return $true }
    $title = New-Object System.Text.StringBuilder 512
    [void][DesktopBridge.Native]::GetWindowTextW($h, $title, 512)
    if ($title.Length -gt 0) { [void]$visible.Add($title.ToString()) }
    return $true
  }
  [void][DesktopBridge.Native]::EnumWindows($callback, [IntPtr]::Zero)
  $fingerprint['windowTitles'] = @($visible)
  $fingerprint['windowCount'] = $visible.Count
  # Scope of the *content* probe: the top-level window we are acting on (window-at-point when
  # --x/--y were given, else the foreground window). Only this cheap scope reading stays here --
  # it is plain Win32, no UIA. The UIA content readings themselves were moved OUT of this process
  # into their own command (`snapshot`), because a UIA read can kill the process with a
  # corrupted-state exception that try/catch cannot stop (design.md I7e). When that happens the
  # caller loses one content reading, not the whole before/after state -- and it must report
  # CHANGED=unknown, never false.
  $contentRoot = [DesktopBridge.Native]::GetForegroundWindow()
  if ($X -ne '' -and $Y -ne '') {
    if ($hit -ne [IntPtr]::Zero) { $contentRoot = [DesktopBridge.Native]::GetAncestor($hit, 2) }  # GA_ROOT
  }
  $fingerprint['contentRoot'] = ('0x{0:x}' -f $contentRoot.ToInt64())
  Write-Report ([ordered]@{
    ok = $true
    verify = $fingerprint
    ourIntegrity = Get-OurIntegrity
    dpiAware = $script:DpiMode
  })
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
$report = [ordered]@{ ok = $false }
$exitCode = 0

function Write-Report {
  param([hashtable]$Data)
  foreach ($key in $Data.Keys) { $report[$key] = $Data[$key] }
}

function Fail {
  param([string]$Message)
  $report['ok'] = $false
  $report['error'] = $Message
  $script:exitCode = 1
}

try {
  Initialize-Dpi
  $script:foundMatch = $null
  # Load the native types once, before any command runs. Several helpers call Add-NativeTypes
# themselves for safety, but anything that touches [DesktopBridge.Native] without doing so
# (e.g. window enumeration, which resolves process names) would fail if this is not done first.
try { Add-NativeTypes } catch { }

switch ($Command) {
    'profile' { Invoke-ProfileCommand }
    'screen' { Invoke-ScreenCommand }
    'windows' { Invoke-WindowsCommand }
    'uia' { Invoke-UiaCommand }
    'point' { Invoke-PointCommand }
    'input' { Invoke-InputCommand }
    'verify' { Invoke-VerifyCommand }
    'snapshot' { Invoke-SnapshotCommand }
    'probe' { Invoke-ProbeCommand }
    default { Fail "unknown command: $Command" }
  }
} catch {
  Fail ($_.Exception.Message)
}

$json = ($report | ConvertTo-Json -Depth 24 -Compress)
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
exit $exitCode