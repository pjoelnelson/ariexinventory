# Creates a self-signed HTTPS certificate so phones can use their camera on the inventory site.
# Run again if this PC's network address changes:  powershell -ExecutionPolicy Bypass -File make-certificate.ps1
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'certs'
New-Item -ItemType Directory -Force $dir | Out-Null

$names = @('localhost', $env:COMPUTERNAME)
$ips = @('127.0.0.1') + (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { $_.IPAddress })
$san = (($names | ForEach-Object { "DNS=$_" }) + ($ips | ForEach-Object { "IPAddress=$_" })) -join '&'

$cert = New-SelfSignedCertificate -Subject 'CN=Barcode Inventory' `
  -TextExtension @("2.5.29.17={text}$san") `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(5)

$pass = [Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
$secure = ConvertTo-SecureString $pass -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $dir 'server.pfx') -Password $secure | Out-Null
Set-Content -Path (Join-Path $dir 'passphrase.txt') -Value $pass -NoNewline -Encoding ascii
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"   # keep it only in the certs folder

Write-Host "Certificate created for: $($names + $ips -join ', ')"
Write-Host "Restart the server (start.bat) to use it."
