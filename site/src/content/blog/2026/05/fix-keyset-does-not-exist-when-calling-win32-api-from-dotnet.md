---
title: "Fix: System.Security.Cryptography.CryptographicException: Keyset does not exist"
description: "The certificate's private key lives in a separate Windows key file the current process identity cannot read. Grant ACL on the key, load the PFX with MachineKeySet, or use EphemeralKeySet."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "cryptography"
  - "x509"
  - "windows"
---

The fix: this is `NTE_BAD_KEYSET` (HRESULT `0x80090016`) bubbling up from a Win32 crypto call. The certificate object you are holding has a public key, but the **private key file** on disk lives in a separate location, and the current process identity has no read permission on it, or that file no longer exists for the user profile you are running under. Three resolutions cover almost every case: grant the process identity read access to the private key (certificate snap-in or `icacls` on the key container file), load the PFX with `X509KeyStorageFlags.MachineKeySet | PersistKeySet` so the key lands in the machine store, or load the PFX with `EphemeralKeySet` so no disk file is needed at all.

```text
System.Security.Cryptography.CryptographicException: Keyset does not exist
   at System.Security.Cryptography.CryptographicException.ThrowCryptographicException(Int32 hr)
   at System.Security.Cryptography.X509Certificates.CertificatePal.GetPrivateKey[T](Func`2 createCsp, Func`2 createCng)
   at System.Security.Cryptography.X509Certificates.X509Certificate2.GetRSAPrivateKey()
   at MyApp.SigningService.Sign(Byte[] payload)
```

This guide is written against .NET 11 preview 4 on Windows Server 2025 / Windows 11 24H2. The error has been identical since .NET Framework 1.1 because the message comes verbatim from `NTE_BAD_KEYSET` in `winerror.h`. What changed in modern .NET is the **default key storage behaviour** when you load a PFX: .NET 9 introduced `X509CertificateLoader`, deprecated the `X509Certificate2(byte[])` and `new X509Certificate2(path, password)` constructors for PFX content (`SYSLIB0057`), and shifted the recommended loading path. The new API does **not** silently persist keys to disk the way the old constructors did. If you mechanically replaced one with the other, the error you are reading is the consequence.

Two things to check before applying any fix below. First, `certificate.HasPrivateKey` returns `true` even when the key file is missing or inaccessible. The flag tracks whether the **certificate metadata** advertises a private key, not whether you can actually open it. Second, the error is identical for a missing key container, a key container on a different user profile, and a key container whose ACL denies your process. The remedy depends on which of those three you are looking at; the sections below walk through them in order.

## Why a certificate has a key file at all

On Windows, an X.509 certificate is a public document. The corresponding private key never sits in the certificate file; it lives in a key container managed by the cryptographic provider. There are two providers and two scopes you need to keep straight:

- **CAPI (Microsoft Cryptographic API)**: legacy provider, key containers stored in `%APPDATA%\Microsoft\Crypto\RSA\<SID>\` for the user scope and `%ProgramData%\Microsoft\Crypto\RSA\MachineKeys\` for the machine scope. Each container is a single file with a GUID-like name.
- **CNG (Cryptography Next Generation)**: modern provider, key containers in `%APPDATA%\Microsoft\Crypto\Keys\` and `%ProgramData%\Microsoft\Crypto\Keys\` respectively.

When you import a PFX, the loader writes the certificate to the **Personal certificate store** (`Cert:\CurrentUser\My` or `Cert:\LocalMachine\My`) and the key material into one of those four directories, depending on `X509KeyStorageFlags`. Pulling the certificate out of the store and into a `X509Certificate2` only retrieves the public part plus a pointer to the key container. The first time you call `GetRSAPrivateKey()`, `GetECDsaPrivateKey()`, or the obsolete `PrivateKey` property, the runtime opens that container through the corresponding Win32 API. If the file is gone, the SID has no read ACE, or the path resolves to a profile that does not exist in the current logon session, you get `NTE_BAD_KEYSET`.

The takeaway is that the cert and the key are decoupled, and the question "does this process have the private key" is really "does this process identity have read access to the file referenced by this certificate". Every fix below answers that question in a different way.

## Minimal repro

The shortest program that reproduces the error after switching to the .NET 9+ loader:

```csharp
// .NET 11 preview 4, Windows 11 24H2
using System.Security.Cryptography.X509Certificates;

var bytes = File.ReadAllBytes("signing.pfx");
var cert = X509CertificateLoader.LoadPkcs12(bytes, password: "test");

using var rsa = cert.GetRSAPrivateKey();
var signature = rsa!.SignData("hello"u8.ToArray(), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
```

Run this from an interactive desktop session and it works. Run the same binary as a Windows Service under `NT SERVICE\MyService`, or from an IIS app pool with `LoadUserProfile = false`, and `GetRSAPrivateKey()` throws "Keyset does not exist". The PFX loaded fine. The certificate object was constructed. The crash happens the moment you reach for the private key.

The reason: `X509CertificateLoader.LoadPkcs12` defaults to `X509KeyStorageFlags.DefaultKeySet`, which on Windows means the **user** key store. A service identity without a loaded user profile has no `%APPDATA%\Microsoft\Crypto\...` to write to, so the key file is created in a temporary location that is unreachable on the next call, or never created at all.

## Fix 1: grant the current identity read access to the key

This is the right fix when the certificate is already installed in the machine store and you do not control the import code (typical for ops-managed servers). Open `certlm.msc` (LocalMachine) or `certmgr.msc` (CurrentUser), find the certificate under **Personal > Certificates**, right-click, **All Tasks > Manage Private Keys**, and add the process identity with **Read** permission.

The same operation from PowerShell, scripted for an IIS app pool:

```powershell
# Windows 11 24H2 / Windows Server 2025, PowerShell 7.5
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object Thumbprint -eq 'AABBCC...'
$keyFile = $cert.PrivateKey.Key.UniqueName  # CNG

$keyPath = Join-Path $env:ProgramData "Microsoft\Crypto\Keys\$keyFile"
$acl = Get-Acl $keyPath
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    'IIS APPPOOL\MyAppPool', 'Read', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl $keyPath $acl
```

For CAPI certificates, swap `Crypto\Keys` for `Crypto\RSA\MachineKeys` and read `cert.PrivateKey.CspKeyContainerInfo.UniqueKeyContainerName` instead. The cmdlet name `Get-PfxCertificate` looks tempting here but does not return the live store certificate; use `Get-ChildItem Cert:\...` so the `PrivateKey` property points at the on-disk container.

For a Windows Service running under `NT SERVICE\<ServiceName>`, the SID is virtual and you grant it with `icacls`:

```powershell
icacls $keyPath /grant "NT SERVICE\MyService:R"
```

If you are not sure which SID your process runs under, `whoami /user` from a command prompt launched as that identity will print it. For containerised Windows services, `nt authority\system` and `nt authority\network service` are the usual suspects.

## Fix 2: load the PFX with the right key storage flags

This is the right fix when your application owns the certificate file and loads it at startup. Stop relying on `DefaultKeySet` and be explicit:

```csharp
// .NET 11 preview 4, long-running service that needs the key to survive restarts
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    "signing.pfx",
    password: "test",
    keyStorageFlags: X509KeyStorageFlags.MachineKeySet
                   | X509KeyStorageFlags.PersistKeySet
                   | X509KeyStorageFlags.Exportable);
```

`MachineKeySet` writes the key to `%ProgramData%\Microsoft\Crypto\Keys` (CNG) under an ACL the service identity can read. `PersistKeySet` keeps the file on disk after the `X509Certificate2` is disposed; without it, the default behaviour since .NET Framework 4.7.2 is to delete the key the moment the certificate object goes out of scope, which produces "Keyset does not exist" on the **second** call into the same code path. `Exportable` is optional and only needed if you later call `ExportPkcs8PrivateKey` or write the key to a different store. Note: `PersistKeySet` and `EphemeralKeySet` are mutually exclusive; passing both throws `CryptographicException` from `X509CertificateLoader`.

For a hosted .NET 11 app where you only need the key in-process and never want a disk file, use `EphemeralKeySet` and skip the persistence question entirely:

```csharp
// .NET 11 preview 4, ASP.NET Core minimal API loading a cert from configuration
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    path,
    password,
    keyStorageFlags: X509KeyStorageFlags.EphemeralKeySet);
```

`EphemeralKeySet` is the most robust choice for containers, scale-to-zero workloads, and any environment where the user profile may be missing or recycled. The key lives only inside the `X509Certificate2` instance; once you dispose it, the key is gone. The trade-off is that the cert is not importable into the Windows store afterwards, and on .NET Framework before 4.7.2 / .NET Core before 2.0 the flag did not exist. On Linux and macOS it is a no-op because there is no Windows key file in the first place.

## Fix 3: IIS app pool and Windows service identity quirks

IIS app pools are the single most common source of this error. Two settings determine whether your private key lookup works:

- **Load User Profile**: in `applicationHost.config` or the IIS Manager, under the app pool's **Advanced Settings**, set **Load User Profile** to `True`. Without it, the `IIS APPPOOL\MyAppPool` identity has no `%APPDATA%`, so any code path that defaults to `UserKeySet` or `DefaultKeySet` fails on the second call.
- **Process Model > Identity**: keep it on `ApplicationPoolIdentity` and grant the virtual `IIS APPPOOL\MyAppPool` SID read access on the key file (Fix 1). Do not run app pools as `LocalSystem` to "work around" this; that is a real privilege escalation, not a fix.

For Windows Services authored with the [.NET 11 hosted-service template](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) plus `Microsoft.Extensions.Hosting.WindowsServices`, the equivalent setup is registering the service with its own virtual account:

```powershell
sc.exe create MyService binPath= "C:\svc\MyService.exe" obj= "NT SERVICE\MyService" start= auto
icacls "C:\ProgramData\Microsoft\Crypto\Keys\<keyfile>" /grant "NT SERVICE\MyService:R"
```

Avoid running services under `LocalSystem` for the same reason as app pools: it accidentally also grants read on every other machine key on the host. The principle of least privilege applies to crypto containers just as it does to file paths.

## Fix 4: Azure App Service, Azure Functions, containers

Cloud hosts hit a sharper version of this problem because the underlying file system is not yours. Three platform-specific knobs:

- **Azure App Service**: upload the PFX/PEM to **TLS/SSL settings > Private Key Certificates**, then set the app setting `WEBSITE_LOAD_CERTIFICATES` to either `*` or the certificate's thumbprint. The App Service sandbox refuses to load the private key unless that variable allow-lists the thumbprint; without it you get "Keyset does not exist" the moment you call `GetRSAPrivateKey()`. The `WEBSITE_LOAD_USER_PROFILE = 1` setting is the App Service equivalent of IIS's **Load User Profile** and is required if your code path resolves to user keys.
- **Azure Functions (Windows consumption / Premium)**: same `WEBSITE_LOAD_CERTIFICATES` requirement. For isolated worker functions, prefer loading the certificate from `cert:\CurrentUser\My` over reading a PFX from `D:\home\site\wwwroot`, because the PFX path is read-only and `PersistKeySet` will silently fail.
- **Linux containers (including Linux App Service plans and AKS)**: there is no Windows key file, so `X509KeyStorageFlags` other than `EphemeralKeySet` are effectively ignored. The error you will see in `dotnet publish` images is not "Keyset does not exist" but `PlatformNotSupportedException` if you reach for `CspParameters` or the `PrivateKey = ...` setter. Use the modern `CopyWithPrivateKey` API and `EphemeralKeySet` and the code is portable.

For [.NET 11 AWS Lambda functions](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/), the same logic as Linux containers applies: there is no Windows key store, load PFX with `EphemeralKeySet` from a Lambda layer or Secrets Manager, never from `/tmp` between invocations, because the sandbox does not guarantee `/tmp` survives between cold starts.

## Fix 5: read the key with the modern API, not `PrivateKey`

The `X509Certificate2.PrivateKey` property still exists in .NET 11 but is obsolete (`SYSLIB0028` for the setter, `SYSLIB0058` for the getter on EC keys). It returns an `AsymmetricAlgorithm` that internally calls into CAPI, even when the certificate was imported as CNG, and the CAPI shim is the layer that most reliably throws "Keyset does not exist" when the key container is missing. The modern accessors do an extra check before opening the file and surface clearer exceptions:

```csharp
// .NET 11 preview 4
using var rsa = cert.GetRSAPrivateKey();
using var ecdsa = cert.GetECDsaPrivateKey();
using var dsa = cert.GetDSAPrivateKey();
```

If `HasPrivateKey` is `true` but `GetRSAPrivateKey()` returns `null`, the certificate uses a non-RSA algorithm; try `GetECDsaPrivateKey()` instead. If `GetRSAPrivateKey()` throws "Keyset does not exist", the metadata claims a key exists, the file does not, and one of Fixes 1 through 4 applies.

## Gotchas and lookalikes

- **`X509CertificateLoader` is not optional in .NET 11.** The old `new X509Certificate2(path, password)` constructor is flagged with `SYSLIB0057` and will be removed in a future release. Migrate now and re-read your `X509KeyStorageFlags` choices, because the loader's defaults are stricter.
- **`HasPrivateKey` lies.** It checks the certificate's `keyUsage` extension and the presence of a `CERT_KEY_PROV_INFO_PROP_ID`, not whether the file under `Crypto\Keys` opens cleanly. Test by actually retrieving the key, then catch `CryptographicException` and treat it as "no key", not by branching on `HasPrivateKey`.
- **"Access is denied" is the cousin error.** Same root cause (missing ACL), different code path: legacy CAPI returns `NTE_BAD_KEYSET`, modern CNG sometimes returns `0x80090010 NTE_PERM` which surfaces as `CryptographicException: Access is denied`. The fix is identical; the search hit is different.
- **The PFX is fine; the store reference is stale.** If you imported a PFX, deleted it from `Cert:\LocalMachine\My`, and re-imported, the key file path inside the cert metadata may point at the old (deleted) container. Export, delete completely (with `Remove-Item Cert:\LocalMachine\My\<thumbprint>` plus `certutil -delstore`), and re-import.
- **`SqlClient` and `X509Chain.Build()` throw the same exception.** Both call `GetRSAPrivateKey()` under the hood when validating chains or signing connection strings. A SQL connection failing on certificate auth with this message is the same bug as a JWT signer failing on it; the [`SqlException: Timeout expired` failure mode](/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) is unrelated.
- **CryptoAPI vs CNG mismatches.** Importing a CAPI-generated PFX through CNG (or vice versa) sometimes leaves the key in one provider with metadata pointing to the other. `certutil -repairstore My <thumbprint>` rebuilds the link without re-importing.
- **The user profile is not loaded.** Scheduled Tasks, IIS app pools without `LoadUserProfile`, and Docker Windows containers running as `ContainerUser` all share this property. Either flip the profile setting on, switch to machine keys, or use `EphemeralKeySet`.

## Related

- [Fix: System.IO.FileNotFoundException: Could not load file or assembly](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) covers the other half of "it worked on my machine" deployment errors, where the issue is the binary rather than the key.
- [Fix: PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) is what you see if you publish a Native AOT app and call `new RSACryptoServiceProvider()` directly; the AOT compiler trims the CAPI shim entirely.
- [How to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) shows the surrounding plumbing for the most common reason you are loading a private key in the first place: signing JWTs in a hosted identity provider.
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) discusses certificate loading in serverless environments, where `EphemeralKeySet` is the only key-storage flag that does the right thing.
- [How to set up structured logging with Serilog and Seq in .NET 11](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) is useful for tracing the exact moment the key access fails in a production service, since `X509Certificate2` operations do not log anything by default.

## Sources

- [`X509KeyStorageFlags` Enum, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509keystorageflags)
- [`X509CertificateLoader` class, .NET 9+, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509certificateloader)
- [`SYSLIB0057`: Obsolete X509Certificate2 PFX constructors](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib0057)
- [Private Key Lifetime on Windows, January 2021 .NET Framework rollup, Microsoft Support](https://support.microsoft.com/en-us/topic/private-key-lifetime-on-windows-and-the-january-2021-net-framework-security-and-quality-rollup-3f097a10-f798-4ffd-8511-4757ebaf2c70)
- [`dotnet/runtime` issue 67752: occasional "Keyset does not exist" with `GetRSAPrivateKey` on Windows](https://github.com/dotnet/runtime/issues/67752)
- [`dotnet/aspnetcore` issue 3218: Data Protection "Keyset does not exist" even with PrivateKey set programmatically](https://github.com/dotnet/aspnetcore/issues/3218)
- [Load certificates in Azure App Service, MS Learn](https://learn.microsoft.com/en-us/azure/app-service/configure-ssl-certificate-in-code)
