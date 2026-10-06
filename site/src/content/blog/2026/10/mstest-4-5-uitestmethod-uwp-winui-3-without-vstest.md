---
title: "MSTest 4.5 Runs UWP and WinUI 3 UI Tests Without VSTest"
description: "MSTest.Sdk 4.5 and Microsoft.Testing.Platform 2.5 make the UWP or WinUI 3 app the test host itself. [UITestMethod] runs each test on the real dispatcher, packaged and AppContainer apps are activated by AUMID through a sidecar controller, and unpackaged WinUI finally works."
pubDate: 2026-10-06
tags:
  - "mstest"
  - "winui"
  - "uwp"
  - "testing"
  - "dotnet"
---

On October 5, 2026, Amaury Levé published ["UWP and WinUI 3 apps: UI testing with MSTest"](https://devblogs.microsoft.com/dotnet/testing-uwp-and-winui-3-apps-with-mstest/). The short version: with `MSTest.Sdk` 4.5 (which carries Microsoft.Testing.Platform 2.5), Windows XAML apps no longer need VSTest to run tests. No `Microsoft.NET.Test.Sdk`, no `vstest.console`, no `UwpTestHostRuntimeProvider` from the Visual Studio install.

That last one matters more than it sounds. VSTest routed every `UseWinUI` project through that provider, which reads `AppxManifest.xml` from the build output. An unpackaged WinUI app has no manifest, so it failed with `FileNotFoundException` ([testfx#2784](https://github.com/microsoft/testfx/issues/2784)). Under MTP the app is the test host, so the problem goes away.

## The app hosts the platform from OnLaunched

A WinUI app already generates its own `Main` from `ApplicationDefinition`. `MSTest.Sdk` detects that, suppresses its own entry point, and generates a `MicrosoftTestingPlatformApplication.RunAsync` helper you call once the window exists:

```csharp
using Microsoft.VisualStudio.TestTools.UnitTesting.AppContainer;

protected override async void OnLaunched(LaunchActivatedEventArgs args)
{
    _window = new Window();
    _window.Activate();
    UITestMethodAttribute.DispatcherQueue = _window.DispatcherQueue;

    try
    {
        Environment.ExitCode = await MicrosoftTestingPlatformApplication.RunAsync(
            Environment.GetCommandLineArgs()[1..]);
    }
    finally
    {
        _window.Close();
        Exit();
    }
}
```

The generated WinUI `Main` returns `void`, which is why the exit code is set by hand. Skip that and CI sees a green run no matter what failed.

## UITestMethod, not STATestMethod

`[STATestMethod]` gives you an STA thread, but not a WinUI dispatcher, so creating a `Grid` on it still throws. `[UITestMethod]` sends the whole MSTest call to the published `DispatcherQueue`, including `[TestInitialize]` and `[TestCleanup]`:

```csharp
[UITestMethod]
public async Task GridCanBeCreatedOnTheUIThread()
{
    await Task.Yield();
    var grid = new Grid();
    Assert.IsTrue(grid.DispatcherQueue.HasThreadAccess);
}
```

The `await Task.Yield()` is the interesting line: the continuation comes back to the UI thread, so async tests keep thread access.

## Five app models, one SDK

The [testfx guide](https://github.com/microsoft/testfx/blob/main/docs/winui-testing.md) covers classic UWP (`uap10.0`), modern UWP on .NET 10 with `UseUwp`, packaged WinUI 3, unpackaged WinUI 3 (`WindowsPackageType=None`), and WinUI 3 with `TrustLevel="appContainer"`. Packaged and sandboxed apps cannot be started with `Process.Start`, so MSBuild runs a full-trust sidecar controller that registers the package, activates it by AUMID, and collects TRX, hang dumps, and retry output from the package's storage after it exits. For AppContainer, the controller pipe grants access to the app's exact package SID and rejects `ALL APPLICATION PACKAGES`.

A modern UWP test project is now this:

```xml
<Project Sdk="MSTest.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows10.0.26100.0</TargetFramework>
    <UseUwp>true</UseUwp>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Unpackaged and full-trust packaged apps run with `dotnet test --project MyWinUiTests.csproj -c Release -a x64`. UWP and AppContainer still need Visual Studio's MSBuild: `msbuild MyUwpTests.csproj /t:InvokeTestingPlatform /p:Platform=x64`.

## Before you pin 4.5.0

The post pins `"MSTest.Sdk": "4.5.0"` in `global.json`, but as I write this NuGet.org still lists 4.4.1 as the latest `MSTest.Sdk`. Check the feed before you bump CI. Also plan for the CI agent: packaged and AppContainer runs need Developer Mode or a sideloading policy, AppContainer tests must run non-elevated, and the Windows App SDK runtime has to be installed on the agent.

If you are already on MTP for the [Native AOT source generator in MSTest 4.4](/2026/09/mstest-4-4-native-aot-source-generation/), this is the same runner extended to the last app models that still needed VSTest.
