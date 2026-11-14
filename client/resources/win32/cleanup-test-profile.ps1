param([Parameter(Mandatory=$true)][string]$Name)
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^PaperStudio\.Compiler\.[a-f0-9]{32}$') { throw 'Refusing to delete a non-test sandbox profile' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PaperStudioTestCleanup {
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)]
  public static extern int DeleteAppContainerProfile(string name);
}
'@
$result = [PaperStudioTestCleanup]::DeleteAppContainerProfile($Name)
if ($result -ne 0) { throw ('DeleteAppContainerProfile failed: 0x' + $result.ToString('X8')) }
Write-Output ('Deleted test profile: ' + $Name)
