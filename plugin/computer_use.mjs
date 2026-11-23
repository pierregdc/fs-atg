import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent } from './logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const COMPUTER_CAPTURE_DIR = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_captures');

export const COMPUTER_ACTIONS = Object.freeze([
  'screen_info',
  'screenshot',
  'windows',
  'focus_window',
  'mouse_move',
  'click',
  'double_click',
  'right_click',
  'drag',
  'scroll',
  'type',
  'key',
  'hotkey',
  'clipboard_get',
  'clipboard_set',
]);

const FORBIDDEN_HOTKEYS = new Set([
  'ctrl+alt+del',
  'ctrl+alt+delete',
  'win+r',
  'win+x',
  'alt+f4',
]);

function normalizeHotkeyString(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/control/g, 'ctrl')
    .replace(/command|cmd|meta|super/g, 'win');
}

export function validateComputerAction(params = {}, { permissionMode = 'full', computerUseEnabled = true } = {}) {
  const action = String(params?.action || '').trim();
  if (!COMPUTER_ACTIONS.includes(action)) {
    throw new Error(`Action Computer Use inconnue : "${action}". Actions valides : ${COMPUTER_ACTIONS.join(', ')}`);
  }
  const readOnlyActions = new Set(['screen_info', 'screenshot', 'windows', 'clipboard_get']);
  if (!readOnlyActions.has(action)) {
    if (permissionMode === 'plan') {
      throw new Error(`Action "${action}" bloquée en mode Lecture seule (plan). Passe en mode Édition ou Complet.`);
    }
    if (computerUseEnabled === false) {
      throw new Error('Computer Use est désactivé dans les réglages du panneau.');
    }
  }
  if (action === 'hotkey' || action === 'key') {
    const norm = normalizeHotkeyString(params.keys || params.key || '');
    if (!norm) throw new Error('Paramètre "key" ou "keys" requis.');
    if (FORBIDDEN_HOTKEYS.has(norm)) {
      throw new Error(`Raccourci système protégé refusé : ${norm}`);
    }
  }
  if (['mouse_move', 'drag'].includes(action)) {
    if (!Number.isFinite(Number(params.x)) || !Number.isFinite(Number(params.y))) {
      throw new Error(`Coordonnées x et y numériques requises pour "${action}".`);
    }
  }
  if (action === 'drag') {
    if (!Number.isFinite(Number(params.toX)) || !Number.isFinite(Number(params.toY))) {
      throw new Error('Coordonnées toX et toY numériques requises pour "drag".');
    }
  }
  return action;
}

function runPowerShellJson(script, payloadObj = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const b64Payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64');
    const fullScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = 'Stop'\n$payloadJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Payload}'))\n$p = $payloadJson | ConvertFrom-Json\n` + script;
    const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');

    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Timeout Computer Use (${Math.round(timeoutMs / 1000)}s).`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
      try {
        const parsed = JSON.parse(lastLine);
        if (parsed && parsed.ok === false) {
          reject(new Error(parsed.error || 'Erreur Computer Use.'));
          return;
        }
        resolve(parsed);
      } catch {
        if (code !== 0) {
          reject(new Error((stderr || stdout || `PowerShell exit ${code}`).trim().slice(0, 320)));
        } else {
          resolve({ ok: true, raw: stdout.trim() });
        }
      }
    });
  });
}

const WIN32_CSHARP_HEADER = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ("FsAtgWin32" -as [type])) {
  $csCode = 'using System; using System.Runtime.InteropServices; using System.Text; public static class FsAtgWin32 { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, IntPtr dwExtraInfo); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
  Add-Type -TypeDefinition $csCode
}
[void][FsAtgWin32]::SetProcessDPIAware()
`;

function toSendKeysPattern(rawKey, isHotkey = false) {
  const s = String(rawKey || '').trim();
  if (!isHotkey) {
    const map = {
      enter: '{ENTER}', return: '{ENTER}',
      escape: '{ESC}', esc: '{ESC}',
      tab: '{TAB}',
      backspace: '{BACKSPACE}', bs: '{BACKSPACE}',
      delete: '{DELETE}', del: '{DELETE}',
      up: '{UP}', arrowup: '{UP}',
      down: '{DOWN}', arrowdown: '{DOWN}',
      left: '{LEFT}', arrowleft: '{LEFT}',
      right: '{RIGHT}', arrowright: '{RIGHT}',
      home: '{HOME}', end: '{END}',
      pageup: '{PGUP}', pgup: '{PGUP}',
      pagedown: '{PGDN}', pgdn: '{PGDN}',
      space: ' ',
      f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
      f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
    };
    const low = s.toLowerCase();
    return map[low] || s.replace(/([+^%~(){}])/g, '{$1}');
  }
  const parts = s.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  let prefix = '';
  let main = '';
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') prefix += '^';
    else if (part === 'alt') prefix += '%';
    else if (part === 'shift') prefix += '+';
    else main = toSendKeysPattern(part, false);
  }
  return `${prefix}${main}`;
}

export async function executeComputerAction(params = {}, options = {}) {
  const action = validateComputerAction(params, options);

  if (process.platform !== 'win32') {
    throw new Error(`Computer Use natif requiert Windows (plateforme actuelle : ${process.platform}).`);
  }

  try {
    mkdirSync(COMPUTER_CAPTURE_DIR, { recursive: true });
  } catch {}

  switch (action) {
    case 'screen_info': {
      const res = await runPowerShellJson(`
${WIN32_CSHARP_HEADER}
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  @{
    deviceName = $_.DeviceName
    primary = [bool]$_.Primary
    x = $_.Bounds.X
    y = $_.Bounds.Y
    width = $_.Bounds.Width
    height = $_.Bounds.Height
    workingArea = @{ x = $_.WorkingArea.X; y = $_.WorkingArea.Y; width = $_.WorkingArea.Width; height = $_.WorkingArea.Height }
  }
})
$pos = [System.Windows.Forms.Cursor]::Position
$fg = [FsAtgWin32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FsAtgWin32]::GetWindowText($fg, $sb, 512)
@{
  ok = $true
  action = 'screen_info'
  cursor = @{ x = $pos.X; y = $pos.Y }
  activeWindow = $sb.ToString()
  screens = $screens
} | ConvertTo-Json -Compress -Depth 5
`);
      return res;
    }

    case 'screenshot': {
      const fileName = `capture_${Date.now()}_${randomUUID().slice(0, 6)}.png`;
      const outPath = params.outputPath ? String(params.outputPath) : join(COMPUTER_CAPTURE_DIR, fileName);
      const region = params.region && typeof params.region === 'object' ? params.region : null;
      const res = await runPowerShellJson(`
${WIN32_CSHARP_HEADER}
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$rx = if ($null -ne $p.rx) { [int]$p.rx } else { $bounds.X }
$ry = if ($null -ne $p.ry) { [int]$p.ry } else { $bounds.Y }
$rw = if ($null -ne $p.rw -and [int]$p.rw -gt 0) { [int]$p.rw } else { $bounds.Width }
$rh = if ($null -ne $p.rh -and [int]$p.rh -gt 0) { [int]$p.rh } else { $bounds.Height }
$bmp = New-Object System.Drawing.Bitmap($rw, $rh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$protectedSurface = $false
try {
  $g.CopyFromScreen($rx, $ry, 0, 0, (New-Object System.Drawing.Size($rw, $rh)))
} catch {
  $protectedSurface = $true
  $g.Clear([System.Drawing.Color]::FromArgb(15, 23, 42))
}
$g.Dispose()
$dir = Split-Path -Parent $p.outPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$bmp.Save($p.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$pos = [System.Windows.Forms.Cursor]::Position
$fg = [FsAtgWin32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FsAtgWin32]::GetWindowText($fg, $sb, 512)
@{
  ok = $true
  action = 'screenshot'
  path = $p.outPath
  width = $rw
  height = $rh
  protectedSurface = $protectedSurface
  cursor = @{ x = $pos.X; y = $pos.Y }
  activeWindow = $sb.ToString()
} | ConvertTo-Json -Compress
`, {
        outPath,
        rx: region?.x ?? null,
        ry: region?.y ?? null,
        rw: region?.width ?? null,
        rh: region?.height ?? null,
      });
      const bytes = existsSync(outPath) ? statSync(outPath).size : 0;
      logEvent('info', 'computer', 'computer.screenshot', `Capture écran enregistrée (${res.width}x${res.height}, ${bytes} octets).`, { path: outPath });
      return { ...res, bytes };
    }

    case 'windows': {
      return await runPowerShellJson(`
$list = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 40 | ForEach-Object {
  @{
    pid = $_.Id
    processName = $_.ProcessName
    title = $_.MainWindowTitle
  }
})
@{ ok = $true; action = 'windows'; count = $list.Count; windows = $list } | ConvertTo-Json -Compress -Depth 4
`);
    }

    case 'focus_window': {
      const query = String(params.title || params.processName || '').trim();
      const pid = Number(params.pid) || null;
      if (!query && !pid) throw new Error('Paramètre "title", "processName" ou "pid" requis pour focus_window.');
      const res = await runPowerShellJson(`
${WIN32_CSHARP_HEADER}
$proc = $null
if ($p.pid) {
  $proc = Get-Process -Id ([int]$p.pid) -ErrorAction SilentlyContinue
} else {
  $q = [string]$p.query
  $proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$q*" -or $_.ProcessName -like "*$q*") } | Select-Object -First 1
}
if (-not $proc -or $proc.MainWindowHandle -eq 0) {
  @{ ok = $false; error = "Fenêtre introuvable." } | ConvertTo-Json -Compress
  exit 0
}
[void][FsAtgWin32]::ShowWindow($proc.MainWindowHandle, 9)
[void][FsAtgWin32]::SetForegroundWindow($proc.MainWindowHandle)
@{ ok = $true; action = 'focus_window'; pid = $proc.Id; title = $proc.MainWindowTitle; processName = $proc.ProcessName } | ConvertTo-Json -Compress
`, { query, pid });
      logEvent('info', 'computer', 'computer.focus_window', `Fenêtre activée : ${res.title || query}`);
      return res;
    }

    case 'mouse_move':
    case 'click':
    case 'double_click':
    case 'right_click': {
      const hasCoords = params.x !== undefined && params.y !== undefined;
      const x = hasCoords ? Math.round(Number(params.x)) : null;
      const y = hasCoords ? Math.round(Number(params.y)) : null;
      const res = await runPowerShellJson(`
${WIN32_CSHARP_HEADER}
if ($null -ne $p.x -and $null -ne $p.y) {
  [void][FsAtgWin32]::SetCursorPos([int]$p.x, [int]$p.y)
  Start-Sleep -Milliseconds 25
}
$pos = [System.Windows.Forms.Cursor]::Position
switch ([string]$p.act) {
  'click' {
    [FsAtgWin32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    [FsAtgWin32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  }
  'double_click' {
    [FsAtgWin32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    [FsAtgWin32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [FsAtgWin32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    [FsAtgWin32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  }
  'right_click' {
    [FsAtgWin32]::mouse_event(0x0008, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    [FsAtgWin32]::mouse_event(0x0010, 0, 0, 0, [IntPtr]::Zero)
  }
}
$finalPos = [System.Windows.Forms.Cursor]::Position
@{ ok = $true; action = [string]$p.act; cursor = @{ x = $finalPos.X; y = $finalPos.Y } } | ConvertTo-Json -Compress
`, { act: action, x, y });
      logEvent('info', 'computer', `computer.${action}`, `Souris ${action} (${res.cursor?.x}, ${res.cursor?.y}).`);
      return res;
    }

    case 'drag': {
      const x = Math.round(Number(params.x));
      const y = Math.round(Number(params.y));
      const toX = Math.round(Number(params.toX));
      const toY = Math.round(Number(params.toY));
      const res = await runPowerShellJson(`
${WIN32_CSHARP_HEADER}
[void][FsAtgWin32]::SetCursorPos([int]$p.x, [int]$p.y)
Start-Sleep -Milliseconds 40
[FsAtgWin32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
$steps = 12
for ($i = 1; $i -le $steps; $i++) {
  $cx = [int]($p.x + (($p.toX - $p.x) * $i / $steps))
  $cy = [int]($p.y + (($p.toY - $p.y) * $i / $steps))
  [void][FsAtgWin32]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 12
}
[FsAtgWin32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
@{ ok = $true; action = 'drag'; from = @{ x = $p.x; y = $p.y }; to = @{ x = $p.toX; y = $p.toY } } | ConvertTo-Json -Compress
`, { x, y, toX, toY });
      logEvent('info', 'computer', 'computer.drag', `Glisser-déposer (${x},${y}) -> (${toX},${toY}).`);
      return res;
    }

    case 'scroll': {
      const deltaY = Math.round(Number(params.deltaY ?? -360));
      const x = params.x !== undefined ? Math.round(Number(params.x)) : null;
      const y = params.y !== undefined ? Math.round(Number(params.y)) : null;
      return await runPowerShellJson(`
${WIN32_CSHARP_HEADER}
if ($null -ne $p.x -and $null -ne $p.y) {
  [void][FsAtgWin32]::SetCursorPos([int]$p.x, [int]$p.y)
  Start-Sleep -Milliseconds 20
}
[FsAtgWin32]::mouse_event(0x0800, 0, 0, [int]$p.deltaY, [IntPtr]::Zero)
@{ ok = $true; action = 'scroll'; deltaY = [int]$p.deltaY } | ConvertTo-Json -Compress
`, { deltaY, x, y });
    }

    case 'type': {
      const text = String(params.text ?? '');
      if (!text) throw new Error('Paramètre "text" requis pour type.');
      const pattern = text.replace(/([+^%~(){}])/g, '{$1}').replace(/\r?\n/g, '{ENTER}');
      await runPowerShellJson(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait([string]$p.pattern)
@{ ok = $true; action = 'type'; length = ([string]$p.text).Length } | ConvertTo-Json -Compress
`, { pattern, text });
      logEvent('info', 'computer', 'computer.type', `Saisie clavier (${text.length} caractères).`);
      return { ok: true, action: 'type', length: text.length };
    }

    case 'key':
    case 'hotkey': {
      const raw = String(params.keys || params.key || '').trim();
      const pattern = toSendKeysPattern(raw, action === 'hotkey' || raw.includes('+'));
      await runPowerShellJson(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait([string]$p.pattern)
@{ ok = $true; action = [string]$p.act; key = [string]$p.raw } | ConvertTo-Json -Compress
`, { act: action, raw, pattern });
      logEvent('info', 'computer', `computer.${action}`, `Touche envoyée : ${raw}`);
      return { ok: true, action, key: raw, pattern };
    }

    case 'clipboard_get': {
      return await runPowerShellJson(`
$txt = Get-Clipboard -Raw -ErrorAction SilentlyContinue
@{ ok = $true; action = 'clipboard_get'; text = [string]$txt } | ConvertTo-Json -Compress
`);
    }

    case 'clipboard_set': {
      const text = String(params.text ?? '');
      await runPowerShellJson(`
Set-Clipboard -Value ([string]$p.text)
@{ ok = $true; action = 'clipboard_set'; length = ([string]$p.text).Length } | ConvertTo-Json -Compress
`, { text });
      return { ok: true, action: 'clipboard_set', length: text.length };
    }

    default:
      throw new Error(`Action non supportée : ${action}`);
  }
}
