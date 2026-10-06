---
title: "MSTest 4.5 ejecuta pruebas de UI de UWP y WinUI 3 sin VSTest"
description: "MSTest.Sdk 4.5 y Microsoft.Testing.Platform 2.5 convierten la aplicación UWP o WinUI 3 en el propio host de pruebas. [UITestMethod] ejecuta cada prueba en el dispatcher real, las aplicaciones empaquetadas y AppContainer se activan por AUMID mediante un controlador auxiliar, y WinUI sin empaquetar por fin funciona."
pubDate: 2026-10-06
tags:
  - "mstest"
  - "winui"
  - "uwp"
  - "testing"
  - "dotnet"
lang: "es"
translationOf: "2026/10/mstest-4-5-uitestmethod-uwp-winui-3-without-vstest"
translatedBy: "claude"
translationDate: 2026-10-06
---

El 5 de octubre de 2026, Amaury Levé publicó ["UWP and WinUI 3 apps: UI testing with MSTest"](https://devblogs.microsoft.com/dotnet/testing-uwp-and-winui-3-apps-with-mstest/). La versión corta: con `MSTest.Sdk` 4.5 (que incluye Microsoft.Testing.Platform 2.5), las aplicaciones XAML de Windows ya no necesitan VSTest para ejecutar pruebas. Sin `Microsoft.NET.Test.Sdk`, sin `vstest.console`, sin `UwpTestHostRuntimeProvider` de la instalación de Visual Studio.

Esto último importa más de lo que parece. VSTest enrutaba cada proyecto `UseWinUI` a través de ese proveedor, que lee `AppxManifest.xml` de la salida de compilación. Una aplicación WinUI sin empaquetar no tiene manifiesto, así que fallaba con `FileNotFoundException` ([testfx#2784](https://github.com/microsoft/testfx/issues/2784)). Con MTP la aplicación es el host de pruebas, así que el problema desaparece.

## La aplicación aloja la plataforma desde OnLaunched

Una aplicación WinUI ya genera su propio `Main` a partir de `ApplicationDefinition`. `MSTest.Sdk` lo detecta, suprime su propio punto de entrada y genera un helper `MicrosoftTestingPlatformApplication.RunAsync` que llamas una vez que existe la ventana:

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

El `Main` de WinUI que se genera devuelve `void`, y por eso el código de salida se asigna a mano. Si lo omites, CI verá una ejecución en verde pase lo que pase.

## UITestMethod, no STATestMethod

`[STATestMethod]` te da un hilo STA, pero no un dispatcher de WinUI, así que crear un `Grid` en él sigue lanzando una excepción. `[UITestMethod]` envía toda la llamada de MSTest al `DispatcherQueue` publicado, incluidos `[TestInitialize]` y `[TestCleanup]`:

```csharp
[UITestMethod]
public async Task GridCanBeCreatedOnTheUIThread()
{
    await Task.Yield();
    var grid = new Grid();
    Assert.IsTrue(grid.DispatcherQueue.HasThreadAccess);
}
```

La línea interesante es `await Task.Yield()`: la continuación vuelve al hilo de UI, así que las pruebas asíncronas conservan el acceso al hilo.

## Cinco modelos de aplicación, un solo SDK

La [guía de testfx](https://github.com/microsoft/testfx/blob/main/docs/winui-testing.md) cubre UWP clásico (`uap10.0`), UWP moderno en .NET 10 con `UseUwp`, WinUI 3 empaquetado, WinUI 3 sin empaquetar (`WindowsPackageType=None`) y WinUI 3 con `TrustLevel="appContainer"`. Las aplicaciones empaquetadas y en sandbox no se pueden iniciar con `Process.Start`, así que MSBuild ejecuta un controlador auxiliar de plena confianza que registra el paquete, lo activa por AUMID y recoge TRX, volcados por bloqueo y la salida de reintentos del almacenamiento del paquete una vez que termina. Para AppContainer, la tubería del controlador concede acceso al SID exacto del paquete de la aplicación y rechaza `ALL APPLICATION PACKAGES`.

Un proyecto de pruebas de UWP moderno ahora es así:

```xml
<Project Sdk="MSTest.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows10.0.26100.0</TargetFramework>
    <UseUwp>true</UseUwp>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Las aplicaciones sin empaquetar y las empaquetadas de plena confianza se ejecutan con `dotnet test --project MyWinUiTests.csproj -c Release -a x64`. UWP y AppContainer todavía necesitan el MSBuild de Visual Studio: `msbuild MyUwpTests.csproj /t:InvokeTestingPlatform /p:Platform=x64`.

## Antes de fijar 4.5.0

La publicación fija `"MSTest.Sdk": "4.5.0"` en `global.json`, pero al momento de escribir esto NuGet.org todavía lista 4.4.1 como la última versión de `MSTest.Sdk`. Revisa el feed antes de actualizar CI. Además, planifica el agente de CI: las ejecuciones empaquetadas y de AppContainer necesitan Developer Mode o una política de sideloading, las pruebas de AppContainer deben ejecutarse sin elevación, y el runtime de Windows App SDK tiene que estar instalado en el agente.

Si ya usas MTP con el [generador de código fuente Native AOT de MSTest 4.4](/es/2026/09/mstest-4-4-native-aot-source-generation/), este es el mismo ejecutor extendido a los últimos modelos de aplicación que todavía necesitaban VSTest.
