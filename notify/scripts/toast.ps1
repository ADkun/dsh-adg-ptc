[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Body = '',
    # The AppId decides which name/icon Windows attributes the toast to. The
    # default is the Windows PowerShell console host, which is always present
    # and always allowed to raise a toast.
    [string]$AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe',
    [ValidateSet('default', 'silent')][string]$Sound = 'default',
    # <= 0  -> sticky reminder (stays in the notification center until dismissed)
    # > 7000 -> long duration
    # else   -> short duration
    # Default 0 = sticky: a notification that asks a human to act must not
    # expire on its own (8 seconds read as "it closed before I could read it").
    [int]$DisappearAfterMs = 0
)

# Why Windows PowerShell v1.0 (powershell.exe) and not PowerShell 7 (pwsh.exe):
# only Windows PowerShell projects the WinRT types below; `pwsh` fails with
# "Unable to find type [Windows.UI.Notifications.ToastNotificationManager]".
# Keep this file ASCII-only: non-ASCII text arrives through -Title / -Body as
# real UTF-16 command-line arguments, so the UTF-8-without-BOM reading that both
# Windows PowerShell 5.1 and pwsh apply to a BOM-less script cannot corrupt it.

$ErrorActionPreference = 'Stop'

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
$texts = $xml.GetElementsByTagName('text')

$texts.Item(0).AppendChild($xml.CreateTextNode($Title)) | Out-Null
if (-not [string]::IsNullOrWhiteSpace($Body)) {
    $texts.Item(1).AppendChild($xml.CreateTextNode($Body)) | Out-Null
} else {
    $texts.Item(1).AppendChild($xml.CreateTextNode(' ')) | Out-Null
}

$toastNode = $xml.GetElementsByTagName('toast').Item(0)
$sticky = $DisappearAfterMs -le 0
if ($sticky) {
    $toastNode.SetAttribute('scenario', 'reminder')
} elseif ($DisappearAfterMs -gt 7000) {
    $toastNode.SetAttribute('duration', 'long')
} else {
    $toastNode.SetAttribute('duration', 'short')
}
if ($Sound -eq 'silent') {
    $audio = $xml.CreateElement('audio')
    $audio.SetAttribute('silent', 'true')
    $toastNode.AppendChild($audio) | Out-Null
}
if ($sticky) {
    # scenario="reminder" alone does NOTHING: the shell drops the attribute
    # unless the toast also carries at least one button action.
    #   element-toast (scenario): "reminder" - ... stay on the user's screen
    #     till dismissed. Note that this will be silently ignored unless there's
    #     a toast button action that activates in background.
    #   app-notifications-content (Reminders): You must provide at least one
    #     button on your app notification. Otherwise, the notification will be
    #     treated as a normal notification.
    # Measured on this machine 2026-10-08: reminder with no <actions> left the
    # screen in under 20 s; the same toast plus the single action below was
    # still on screen at 72 s. So the button is what makes the scenario real.
    # It is a system dismiss: clicking it removes the toast and launches no
    # process (arguments/activationType are the raw-XML system-action form
    # documented under Snooze/dismiss). content is mandatory on element-action
    # and must actually be there: measured 2026-10-08, the same toast with the
    # content attribute left out never reached the screen at all.
    # <actions> goes last: the toast schema fixes the child order to
    # visual, audio?, commands?, actions?, header?.
    $actions = $xml.CreateElement('actions')
    $action = $xml.CreateElement('action')
    $action.SetAttribute('content', 'Dismiss')
    $action.SetAttribute('arguments', 'dismiss')
    $action.SetAttribute('activationType', 'system')
    $actions.AppendChild($action) | Out-Null
    $toastNode.AppendChild($actions) | Out-Null
}

$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
if ($DisappearAfterMs -gt 0) {
    $toast.ExpirationTime = [System.DateTimeOffset]::Now.AddMilliseconds([double]$DisappearAfterMs)
}

[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)

Write-Output 'toast-shown'