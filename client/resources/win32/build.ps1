param([switch]$Fixture)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework 4.x C# compiler is required; sandbox is not optional.' }
$sources = @('Native.cs', 'FileSystem.cs', 'Policy.cs', 'Attributes.cs', 'Job.cs', 'Environment.cs', 'Program.cs', 'RuntimeCapability.cs', 'SessionPolicy.cs', 'SessionWire.cs', 'SessionRun.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
$output = Join-Path $PSScriptRoot $(if ($Fixture) { 'PaperStudio.Sandbox.Fixture.exe' } else { 'PaperStudio.Sandbox.exe' })
$flags = @('/nologo', '/optimize+', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll')
if ($Fixture) { $flags += '/define:SANDBOX_FIXTURE' }
& $compiler $flags "/out:$output" $sources
if ($LASTEXITCODE -ne 0) { throw "Sandbox compilation failed: $LASTEXITCODE" }
Write-Output $output
