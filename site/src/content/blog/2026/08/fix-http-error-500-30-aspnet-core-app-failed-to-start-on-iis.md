---
title: "Fix: HTTP Error 500.30 - ASP.NET Core app failed to start after deploying to IIS"
description: "500.30 means your app threw during startup inside w3wp.exe. The real exception is already in the Windows Application event log under IIS AspNetCore Module V2. Read that first, then rank the fix: missing shared framework, x86/x64 app pool mismatch, missing config, or app pool permissions."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "iis"
  - "deployment"
---

`500.30` is not a cause, it is IIS reporting that the ASP.NET Core Module booted the CLR inside `w3wp.exe` and your app threw before it could start listening. The real exception is almost certainly already on the server: open Event Viewer, go to **Windows Logs > Application**, and find the most recent entry with source **IIS AspNetCore Module V2**. When `stdoutLogEnabled` is `false`, the module captures startup errors and writes up to 30 KB of them to that event, stack trace included. If the entry only gives you `exception code = '0xe0434352'` and nothing else, set `stdoutLogEnabled="true"` in `web.config` and hit the site again. Everything after that is ranking the four things that actually cause it.

```text
HTTP Error 500.30 - ASP.NET Core app failed to start
```

Older ASP.NET Core Module builds render exactly the same failure as `HTTP Error 500.30 - ANCM In-Process Start Failure`, which is still the string the Microsoft docs use in their error tables. Both mean the identical thing. Everything below is verified against .NET 11 (Preview 6, SDK `11.0.100-preview.6.26359.118`) with ANCM V2 from the current .NET Hosting Bundle. The mechanism has not changed since in-process hosting became the default in ASP.NET Core 3.0, so every step applies unchanged to `net8.0`, `net9.0`, and `net10.0` deployments.

## Why 500.30 is a symptom and not a diagnosis

Since ASP.NET Core 3.0, apps default to the **in-process hosting model**. The `<AspNetCoreHostingModel>` MSBuild property defaults to `InProcess`, and `dotnet publish` writes `hostingModel="inprocess"` into `web.config`. In that model there is no separate `dotnet.exe` process. `aspnetcorev2.dll` loads the in-process request handler into the IIS worker process, boots CoreCLR there, and your `Program.cs` runs inside `w3wp.exe` using `IISHttpServer` instead of Kestrel.

That gives you one process instead of two and a meaningful throughput win, but it collapses your error reporting. When the app throws before `app.Run()` reaches the listening state, the module has a dead CLR inside its own process and one byte of information to give the browser: startup failed. Hence a single status code covering a missing connection string, a 32-bit binary in a 64-bit worker, an uninstalled runtime, and a `DirectoryNotFoundException` on a data protection key ring.

Two consequences are worth internalizing before you start changing things:

- **`startupTimeLimit` does not restart you.** When hosting in-process, if the module's 120-second default start window elapses, the process is killed and *not* relaunched, and `rapidFailsPerMinute` does not apply. Out-of-process hosting retries on the next request. In-process does not.
- **The app pool cannot be shared.** In-process hosting requires one app pool per app. Two in-process apps in one pool produce `500.35`, and mixing an in-process and an out-of-process app in one pool produces `500.34`.

## The minimal repro

The smallest deployment that reproduces it is an app that reads configuration that exists locally and not on the server:

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

string cs = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("Connection string 'Default' is missing.");

builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlServer(cs));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();
```

Locally this runs because `appsettings.Development.json` has the section and `ASPNETCORE_ENVIRONMENT` is `Development`. On the server the environment is `Production`, `appsettings.Production.json` was never added to the publish output, and the throw happens on line 3. F5 works, the deployment 500.30s, and nothing in the app is wrong.

That shape covers a large share of real 500.30 reports: the failure is environmental, so it is invisible on the developer machine by construction.

## Reading the Application event log, which usually ends the investigation

Do this before touching `web.config`. On the server, run Event Viewer as administrator and open **Windows Logs > Application**, or query it directly:

```powershell
# Windows Server 2022+, PowerShell 5.1 or 7.x. Run elevated on the web server.
Get-WinEvent -FilterHashtable @{
    LogName      = 'Application'
    ProviderName = 'IIS AspNetCore Module V2'
} -MaxEvents 5 | Format-List TimeCreated, Id, LevelDisplayName, Message
```

You are looking for one of three shapes.

**Shape 1, the useful one.** A full managed stack trace. The module captured your unhandled startup exception and emitted it to the event log because `stdoutLogEnabled` is `false`. Read the exception type and the top frame, fix that, and you are done. This is the case people skip past because the browser page told them nothing and they assumed the server would too.

**Shape 2, the opaque one:**

```text
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
hit unexpected managed exception, exception code = '0xe0434352'.
Please check the stderr logs for more information.
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
failed to load clr and managed application. CLR worker thread exited prematurely
```

`0xe0434352` is the generic Win32 code for "a managed exception escaped", nothing more. It carries no type and no message. This is the documented signature of an x86 app in an app pool that is not enabled for 32-bit applications, but it also shows up whenever the exception escaped somewhere the module could not capture the detail. Go to the stdout log next.

**Shape 3, nothing at all.** No ANCM event within a minute of your request. That usually means the module never got as far as booting the CLR, and you are actually looking at `500.0`, `500.31`, or `500.32` rather than a startup exception. See the variants section at the end.

## Turning on the stdout log

Edit the deployed `web.config` on the server, not the one in your project. It is regenerated by every publish, which is exactly what you want for a temporary diagnostic switch.

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Deployed web.config, ASP.NET Core Module V2, .NET 11 -->
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath="dotnet"
                  arguments=".\MyApp.dll"
                  stdoutLogEnabled="true"
                  stdoutLogFile=".\logs\stdout"
                  hostingModel="inprocess" />
    </system.webServer>
  </location>
</configuration>
```

Saving `web.config` recycles the app pool, so just request the site again. The module creates the `logs` folder itself for `stdoutLogFile`, and writes a file named with a timestamp and process ID, for example `stdout_20260805184032_5412.log`. The app pool identity needs write access to that folder:

```console
icacls "C:\inetpub\wwwroot\myapp\logs" /grant "IIS AppPool\MyAppPool":(OI)(CI)M
```

Three read notes that save time:

- **The file exists but is empty.** The process died before writing anything to stdout. That points at architecture mismatch or a native load failure, not at your code.
- **The file has normal startup lines and then stops.** Whatever runs immediately after the last line is your suspect.
- **Turn it back off.** `stdoutLogEnabled="true"` writes a new file per process recycle forever and the docs are explicit that leaving it on can take down the app or the server. Set it back to `false` when you have your answer.

If stdout is still silent, the failure is below managed code. Add the module's own debug log:

```xml
<!-- ASP.NET Core Module V2 diagnostic logging. Remove after troubleshooting. -->
<aspNetCore processPath="dotnet"
            arguments=".\MyApp.dll"
            stdoutLogEnabled="false"
            stdoutLogFile=".\logs\stdout"
            hostingModel="inprocess">
  <handlerSettings>
    <handlerSetting name="debugFile" value=".\logs\aspnetcore-debug.log" />
    <handlerSetting name="debugLevel" value="FILE,TRACE" />
  </handlerSettings>
</aspNetCore>
```

Unlike `stdoutLogFile`, the module does **not** create folders for `debugFile`. The `logs` directory must already exist and be writable by the pool identity, or you get nothing and conclude the wrong thing. This log shows hostfxr resolution, which framework versions were considered, and which DLL failed to load.

## Fix 1: the app threw during startup, which is most of them

If the event log or stdout log gave you a stack trace, this is you. The clustering in practice:

1. **Configuration that is present locally and absent on the server.** `appsettings.Production.json` not in the publish output, a User Secrets value that never had a production equivalent, an environment variable set on your machine only. This is the [missing connection string failure](/2026/05/fix-no-connection-string-named-defaultconnection/) in its deployment form.
2. **DI graph failures at `builder.Build()`.** ASP.NET Core validates scopes and the service graph on build in Development, and any `Unable to resolve service for type` or captive-dependency problem surfaces as a 500.30 rather than a helpful page. See [unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) and [cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
3. **External dependencies contacted during startup.** Key Vault with an access policy that does not cover the app pool's managed identity is the case Microsoft calls out by name for 500.30. A migration run at boot, a config provider that reaches a database, an OIDC discovery document fetch on a server with no outbound access: all of them turn a network problem into a startup failure.
4. **Certificate and data protection access.** Loading an X.509 certificate from the machine store, or persisting a data protection key ring to a file path the pool identity cannot write to, throws before the first request.

The structural fix for this whole category is to make startup failures explicit and readable rather than accidental. Validating configuration at boot with [`IValidateOptions<T>` and `ValidateOnStart`](/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) turns "the app 500.30s" into a named `OptionsValidationException` listing exactly which settings are missing, which is the difference between a five-minute fix and an afternoon.

To get the raw exception in the browser on a staging box, add the environment variable to `web.config` and never do this on a public server:

```xml
<!-- Staging and test servers only. Do not ship this to an internet-facing host. -->
<aspNetCore processPath="dotnet" arguments=".\MyApp.dll" hostingModel="inprocess">
  <environmentVariables>
    <environmentVariable name="ASPNETCORE_ENVIRONMENT" value="Development" />
    <environmentVariable name="ASPNETCORE_DETAILEDERRORS" value="true" />
  </environmentVariables>
</aspNetCore>
```

## Fix 2: the shared framework the app targets is not installed

Microsoft lists this first among 500.30 causes: the app targets a version of the ASP.NET Core shared framework that is not present. Check what the server actually has:

```console
dotnet --list-runtimes
```

You want a `Microsoft.AspNetCore.App` line whose major version matches your `TargetFramework`, and you want it in the same architecture as the app pool. If the app is `net11.0` and the server tops out at `Microsoft.AspNetCore.App 10.0.x`, that is your answer, because ASP.NET Core does not roll forward across major versions by default.

Install the **.NET Hosting Bundle**, which installs the runtime, the ASP.NET Core shared framework, and ANCM in one package. Two installation rules cause more 500.30s than the download itself:

- **IIS must be installed before the Hosting Bundle.** If the bundle went on first, running the installer again to repair it is required, not optional.
- **Restart the web server after installing.** The installer changes the system `PATH`, and ASP.NET Core does not roll forward for patch releases of shared framework packages either, so the same restart is needed after every bundle upgrade:

```console
net stop was /y
net start w3svc
```

A full `iisreset` works too. Skipping this step is why "I installed the runtime and it still fails" is such a common follow-up.

## Fix 3: the app and the app pool disagree about bitness

In-process hosting requires the architecture of the app and the installed runtime to match the architecture of the app pool. There is no adaptation layer. A 32-bit binary cannot boot CoreCLR inside a 64-bit `w3wp.exe`.

In IIS Manager, select the app pool, choose **Advanced Settings**, and set **Enable 32-Bit Applications**:

- `True` for an x86 app, including an x86 self-contained deployment published with a 32-bit SDK.
- `False` for an x64 app.

Or from the command line:

```console
%windir%\system32\inetsrv\appcmd set apppool /apppool.name:MyAppPool /enable32BitAppOnWin64:false
```

While you are in there, set **.NET CLR version** to **No Managed Code** in Basic Settings. ASP.NET Core boots CoreCLR itself and never needs the desktop CLR loaded into the worker. It is documented as optional but recommended, and it removes a class of confusing interactions with legacy modules.

One trap specific to the Hosting Bundle: if you installed it with `OPT_NO_X86=1` you have no 32-bit runtime on that machine at all, and an x86 app will fail no matter what the pool is set to.

## Fix 4: the app pool identity cannot read what it needs

The default `ApplicationPoolIdentity` is a virtual account, and every 500.30 caused by permissions looks identical to every other 500.30. If the identity was changed from `ApplicationPoolIdentity` to a domain or service account, verify it has read access to the deployment folder and write access to anywhere the app writes. Grant on the folder using the pool name:

```console
icacls "C:\inetpub\wwwroot\myapp" /grant "IIS AppPool\MyAppPool":(OI)(CI)RX
```

Two cases worth checking directly: reading a certificate's private key from the machine store needs an ACL on the key container, and any code that touches `%USERPROFILE%` needs **Load User Profile** set to `True` on the app pool. It is `True` by default and frequently turned off in hardened environments.

## Cut the surface in half by running the app outside IIS

Before spending another hour on IIS configuration, log on to the server, open a shell in the deployment folder, and run the app directly:

```console
cd C:\inetpub\wwwroot\myapp
set ASPNETCORE_ENVIRONMENT=Production
dotnet MyApp.dll
```

The exception prints to the console with a full stack trace and no logging configuration required. If it throws here, the problem is your app or its configuration and IIS is innocent, which sends you straight to Fix 1. If it starts cleanly and serves on `http://localhost:5000`, the problem is the hosting layer: bitness, permissions, or the module, which sends you to Fix 2, 3, or 4. That single command decides which half of this post you need.

Note the environment variable. Running under your own account with your own environment is not the same as running as the pool identity, so a clean run here does not prove file permissions are correct. It proves the code and the deployed configuration files are.

## The neighbouring codes that are not 500.30

Search traffic for 500.30 collects a lot of near misses. If your page says something else, it is a different problem with a different fix:

- **`500.0 - ANCM In-Process Handler Load Failure`**: the module could not load the in-process request handler at all. Wrong `processPath`, Hosting Bundle not installed, IIS not restarted after installing it, or a missing VC++ redistributable.
- **`500.31 - ANCM Failed to Find Native Dependencies`**: `Microsoft.NETCore.App` or `Microsoft.AspNetCore.App` is not installed. The event log names the exact framework and version that was not found. Install it, retarget, or publish self-contained.
- **`500.32 - ANCM Failed to Load dll`**: processor architecture mismatch, the same root cause as Fix 3 surfacing one layer lower.
- **`500.33 - ANCM Request Handler Load Failure`**: the app does not reference the `Microsoft.AspNetCore.App` framework. Check `.runtimeconfig.json`. A console app with `Microsoft.NET.Sdk` instead of `Microsoft.NET.Sdk.Web` produces this.
- **`500.34` and `500.35`**: mixed hosting models, or two in-process apps, in one app pool. Split them into separate pools.
- **`500.36 - ANCM Out-Of-Process Handler Load Failure`**: `aspnetcorev2_outofprocess.dll` is missing next to `aspnetcorev2.dll`. Repair the Hosting Bundle.
- **`500.37 - ANCM Failed to Start Within Startup Time Limit`**: startup exceeded 120 seconds. Raise `startupTimeLimit`, or stagger the start of many apps competing for CPU on the same box.
- **`500.38 - ANCM Application DLL Not Found`**: you published a single-file executable and in-process hosting does not support that. Set `<PublishSingleFile>false</PublishSingleFile>` or switch to `<AspNetCoreHostingModel>OutOfProcess</AspNetCoreHostingModel>`.
- **`502.5 - Process Failure`**: out-of-process hosting only. The backend process failed to launch or failed to listen on `%ASPNETCORE_PORT%`. Frequently a `BadImageFormatException` from a RID mismatch, visible in the stdout log.
- **`500.19`**: an IIS configuration error reading `web.config` itself, usually because ANCM is not registered or the config is malformed. The app never entered the picture.

Switching to out-of-process hosting is a legitimate diagnostic move rather than a fix. Setting `hostingModel="outofprocess"` in `web.config` recycles the worker and runs your app as a child `dotnet.exe`, where startup failures are much easier to observe and `requestTimeout` and `rapidFailsPerMinute` apply again. Use it to get a readable error, then go back to in-process for the performance.

The overall shape of a 500.30 investigation is short if you take it in order: event log, then run it from the console, then bitness and runtime. It only becomes a long afternoon when you start with the browser page and try to guess.

## Related

- [Fix: Unable to resolve service for type X while attempting to activate Y](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) is the most common managed exception hiding behind a 500.30.
- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) covers the other DI failure that only appears once the container is built.
- [How to validate options at startup with IValidateOptions&lt;T&gt; in .NET 11](/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) turns "the app failed to start" into a named exception that says which setting is wrong.
- [Fix: No connection string named 'DefaultConnection' could be found](/2026/05/fix-no-connection-string-named-defaultconnection/) is the classic configuration gap that survives right up to deployment.
- [Fix: Could not load file or assembly in a published app](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) handles the publish-output problems that show up as a startup failure.
- [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) includes the Hosting Bundle upgrade step that a major-version bump requires on every IIS server.

## Sources

- [Troubleshoot ASP.NET Core on Azure App Service and IIS](https://learn.microsoft.com/en-us/aspnet/core/test/troubleshoot-azure-iis) on MS Learn, for the 500.30 through 500.38 definitions, the stdout log, and the ANCM debug log.
- [Common error troubleshooting for Azure App Service and IIS with ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/azure-iis-errors-reference) for the verbatim Application Log strings, including the `0xe0434352` signature.
- [ASP.NET Core Module (ANCM) for IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/aspnet-core-module) for the `aspNetCore` element attributes, their defaults, and in-process hosting characteristics.
- [Host ASP.NET Core on Windows with IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/) for the Hosting Bundle installation order, `net stop was /y`, and app pool configuration.
- [Install the .NET Hosting Bundle](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/hosting-bundle) for the installer options including `OPT_NO_X86`.
