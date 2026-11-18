param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('get', 'set', 'delete')]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._:-]+$')]
  [string]$Target
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('FsAtgCredentialNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class FsAtgCredentialNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, UInt32 flags);

  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);

  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("Advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credential);
}
'@
}

$CRED_TYPE_GENERIC = 1
$CRED_PERSIST_LOCAL_MACHINE = 2
$ERROR_NOT_FOUND = 1168

function Emit([hashtable]$value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress))
}

try {
  if ($Action -eq 'set') {
    $secret = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($secret)) { throw 'Le secret est vide.' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($secret)
    $blob = [IntPtr]::Zero
    try {
      $blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
      $credential = [FsAtgCredentialNative+CREDENTIAL]::new()
      $credential.Type = $CRED_TYPE_GENERIC
      $credential.TargetName = $Target
      $credential.CredentialBlobSize = [uint32]$bytes.Length
      $credential.CredentialBlob = $blob
      $credential.Persist = $CRED_PERSIST_LOCAL_MACHINE
      $credential.UserName = 'FranceStudentATG'
      if (-not [FsAtgCredentialNative]::CredWrite([ref]$credential, 0)) {
        throw "CredWrite a échoué (Win32 $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
      }
      Emit @{ ok = $true }
    } finally {
      if ($blob -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob) }
    }
    exit 0
  }

  if ($Action -eq 'get') {
    $credentialPtr = [IntPtr]::Zero
    if (-not [FsAtgCredentialNative]::CredRead($Target, $CRED_TYPE_GENERIC, 0, [ref]$credentialPtr)) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($code -eq $ERROR_NOT_FOUND) { Emit @{ ok = $true; found = $false }; exit 0 }
      throw "CredRead a échoué (Win32 $code)."
    }
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPtr, [type][FsAtgCredentialNative+CREDENTIAL])
      if ($credential.CredentialBlobSize -eq 0 -or $credential.CredentialBlob -eq [IntPtr]::Zero) {
        Emit @{ ok = $true; found = $false }
      } else {
        $bytes = New-Object byte[] $credential.CredentialBlobSize
        [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
        Emit @{ ok = $true; found = $true; valueBase64 = [Convert]::ToBase64String($bytes) }
      }
    } finally {
      [FsAtgCredentialNative]::CredFree($credentialPtr)
    }
    exit 0
  }

  if (-not [FsAtgCredentialNative]::CredDelete($Target, $CRED_TYPE_GENERIC, 0)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -ne $ERROR_NOT_FOUND) { throw "CredDelete a échoué (Win32 $code)." }
  }
  Emit @{ ok = $true }
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
  exit 0
}
