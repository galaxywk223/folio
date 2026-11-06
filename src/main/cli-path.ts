import { execFile } from 'node:child_process'
import { join } from 'node:path'

// 安装版启动时把 <安装目录>\resources\bin 加到当前用户的 PATH，新开的终端里就能直接运行 folio。
// 用 .NET 注册表接口读写，保留原有的 %VAR% 写法，也不受长度限制；已经在 PATH 里就什么都不做。
const SCRIPT = [
  '$bin = $env:FOLIO_BIN',
  // FOLIO_ENV_KEY 只用于测试，正常就是 HKCU\Environment。
  "$name = if ($env:FOLIO_ENV_KEY) { $env:FOLIO_ENV_KEY } else { 'Environment' }",
  '$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($name, $true)',
  "$path = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
  "if (($path -split ';') -contains $bin) { exit 0 }",
  "$kind = if ($path) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }",
  "$next = (@($path.TrimEnd(';'), $bin) | Where-Object { $_ }) -join ';'",
  "$key.SetValue('Path', $next, $kind)",
  // 写一个用户环境变量再删掉，让系统广播环境变量已变化。
  "[Environment]::SetEnvironmentVariable('FOLIO_PATH_REFRESH', '1', 'User')",
  "[Environment]::SetEnvironmentVariable('FOLIO_PATH_REFRESH', $null, 'User')",
].join('; ')

function userPathContains(bin: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { windowsHide: true }, (error, stdout) => {
      if (error) { resolve(false); return }
      const line = stdout.split(/\r?\n/).find(row => /^\s*Path\s+REG_/i.test(row)) ?? ''
      const value = line.replace(/^\s*Path\s+REG_\w+\s+/i, '')
      resolve(value.split(';').some(entry => entry.trim().toLowerCase() === bin.toLowerCase()))
    })
  })
}

export const ADD_TO_PATH_SCRIPT = SCRIPT

export async function ensureCliOnPath(resourcesPath: string): Promise<void> {
  if (process.platform !== 'win32') return
  const bin = join(resourcesPath, 'bin')
  if (await userPathContains(bin)) return
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { windowsHide: true, env: { ...process.env, FOLIO_BIN: bin } },
      error => error ? reject(error) : resolve())
  })
}
