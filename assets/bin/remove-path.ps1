# Removes the folio command folder from the current user's PATH. Run by the uninstaller (not on auto-update).
param([string]$Bin, [string]$KeyName = 'Environment')
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($KeyName, $true)
if (-not $key -or -not $Bin) { exit 0 }
$path = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$kept = @($path -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $Bin.TrimEnd('\')) })
if ($kept.Count -eq @($path -split ';' | Where-Object { $_ }).Count) { exit 0 }
$key.SetValue('Path', ($kept -join ';'), $key.GetValueKind('Path'))
[Environment]::SetEnvironmentVariable('FOLIO_PATH_REFRESH', '1', 'User')
[Environment]::SetEnvironmentVariable('FOLIO_PATH_REFRESH', $null, 'User')
