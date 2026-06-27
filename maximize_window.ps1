# Finds the dashboard's browser window by title and forces it to maximize
# via the Win32 API directly. "--start-maximized" alone isn't reliable for
# Chromium's "--app=" mode windows (they can remember their own last size/
# position per site and just ignore the flag), and that window type also
# doesn't reliably respond to its system-menu keyboard shortcut (Alt+Space)
# either - hence going straight to ShowWindow() instead of either of those.
Add-Type -Name Win32 -Namespace NorDashboard -MemberDefinition @"
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
"@

$SW_MAXIMIZE = 3

for ($i = 0; $i -lt 14; $i++) {
    Start-Sleep -Milliseconds 500
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -eq "NOR Dashboard" } | Select-Object -First 1
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        [NorDashboard.Win32]::ShowWindow($proc.MainWindowHandle, $SW_MAXIMIZE)
        break
    }
}
