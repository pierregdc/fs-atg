import { spawn } from 'node:child_process';
import os from 'node:os';
import { logEvent } from './logger.mjs';

export const SYSTEM_ACTIONS = Object.freeze(['overview', 'processes', 'ports', 'notify']);

function runPsJson(script, payload = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const fullScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference='Stop'\n$p = ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))) | ConvertFrom-Json\n` + script;
    const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');

    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('Timeout fs_system.'));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const last = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
      try {
        resolve(JSON.parse(last));
      } catch {
        if (code !== 0) reject(new Error((stderr || stdout || `exit ${code}`).trim().slice(0, 240)));
        else resolve({ ok: true, raw: stdout.trim() });
      }
    });
  });
}

export async function executeSystemAction(params = {}) {
  const action = String(params?.action || 'overview').trim();
  if (!SYSTEM_ACTIONS.includes(action)) {
    throw new Error(`Action fs_system inconnue : "${action}". Actions valides : ${SYSTEM_ACTIONS.join(', ')}`);
  }

  if (action === 'overview') {
    const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
    const cpus = os.cpus();
    return {
      ok: true,
      action: 'overview',
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      nodeVersion: process.version,
      cpuModel: cpus[0]?.model || 'unknown',
      cpuCores: cpus.length,
      memory: {
        totalMb: totalMemMb,
        freeMb: freeMemMb,
        usedPct: Math.round(((totalMemMb - freeMemMb) / Math.max(1, totalMemMb)) * 100),
      },
      uptimeSec: Math.round(os.uptime()),
    };
  }

  if (action === 'processes') {
    const filter = String(params.filter || '').trim();
    const limit = Math.min(40, Math.max(1, Number(params.limit) || 15));
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Liste détaillée des processus supportée sous Windows uniquement.' };
    }
    return await runPsJson(`
$q = [string]$p.filter
$procs = Get-Process | Where-Object { -not $q -or $_.ProcessName -like "*$q*" -or $_.MainWindowTitle -like "*$q*" } |
  Sort-Object WorkingSet64 -Descending |
  Select-Object -First ([int]$p.limit) |
  ForEach-Object {
    @{
      pid = $_.Id
      name = $_.ProcessName
      memoryMb = [math]::Round($_.WorkingSet64 / 1MB, 1)
      title = $_.MainWindowTitle
    }
  }
@{ ok = $true; action = 'processes'; count = @($procs).Count; processes = @($procs) } | ConvertTo-Json -Compress -Depth 4
`, { filter, limit });
  }

  if (action === 'ports') {
    const port = params.port ? Number(params.port) : null;
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Inspection des ports supportée sous Windows uniquement.' };
    }
    return await runPsJson(`
$conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue
if ($p.port) { $conns = $conns | Where-Object { $_.LocalPort -eq [int]$p.port } }
$rows = @($conns | Select-Object -First 30 | ForEach-Object {
  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
  @{
    localAddress = $_.LocalAddress
    localPort = $_.LocalPort
    pid = $_.OwningProcess
    processName = if ($proc) { $proc.ProcessName } else { $null }
  }
})
@{ ok = $true; action = 'ports'; count = $rows.Count; listeners = $rows } | ConvertTo-Json -Compress -Depth 4
`, { port });
  }

  if (action === 'notify') {
    const title = String(params.title || 'France Student [ATG]').trim().slice(0, 80);
    const message = String(params.message || '').trim().slice(0, 240);
    if (!message) throw new Error('Paramètre "message" requis pour notify.');
    if (process.platform === 'win32') {
      await runPsJson(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = [string]$p.title
$n.BalloonTipText = [string]$p.message
$n.Visible = $true
$n.ShowBalloonTip(4000)
Start-Sleep -Milliseconds 350
$n.Dispose()
@{ ok = $true; action = 'notify' } | ConvertTo-Json -Compress
`, { title, message });
    }
    logEvent('info', 'system', 'system.notify', `Notification : ${title} — ${message}`);
    return { ok: true, action: 'notify', title, message };
  }

  throw new Error(`Action non supportée : ${action}`);
}
