---
title: "MSTest 4.5 запускает UI-тесты UWP и WinUI 3 без VSTest"
description: "MSTest.Sdk 4.5 и Microsoft.Testing.Platform 2.5 делают само приложение UWP или WinUI 3 хостом тестов. [UITestMethod] выполняет каждый тест в настоящем диспетчере, упакованные приложения и приложения AppContainer активируются по AUMID через вспомогательный контроллер, а неупакованный WinUI наконец заработал."
pubDate: 2026-10-06
tags:
  - "mstest"
  - "winui"
  - "uwp"
  - "testing"
  - "dotnet"
lang: "ru"
translationOf: "2026/10/mstest-4-5-uitestmethod-uwp-winui-3-without-vstest"
translatedBy: "claude"
translationDate: 2026-10-06
---

5 октября 2026 года Amaury Levé опубликовал ["UWP and WinUI 3 apps: UI testing with MSTest"](https://devblogs.microsoft.com/dotnet/testing-uwp-and-winui-3-apps-with-mstest/). Если коротко: с `MSTest.Sdk` 4.5 (в нём Microsoft.Testing.Platform 2.5) приложениям Windows XAML больше не нужен VSTest для запуска тестов. Не нужны ни `Microsoft.NET.Test.Sdk`, ни `vstest.console`, ни `UwpTestHostRuntimeProvider` из установки Visual Studio.

Последний пункт важнее, чем кажется. VSTest направлял каждый проект с `UseWinUI` через этот провайдер, а тот читает `AppxManifest.xml` из выходных файлов сборки. У неупакованного приложения WinUI манифеста нет, поэтому запуск падал с `FileNotFoundException` ([testfx#2784](https://github.com/microsoft/testfx/issues/2784)). В MTP хостом тестов служит само приложение, так что проблема исчезает.

## Приложение запускает платформу из OnLaunched

Приложение WinUI уже генерирует собственный `Main` из `ApplicationDefinition`. `MSTest.Sdk` обнаруживает это, отключает свою точку входа и генерирует вспомогательный метод `MicrosoftTestingPlatformApplication.RunAsync`, который вы вызываете после создания окна:

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

Сгенерированный `Main` для WinUI возвращает `void`, поэтому код выхода приходится задавать вручную. Если этого не сделать, CI покажет зелёный прогон независимо от того, что именно упало.

## UITestMethod, а не STATestMethod

`[STATestMethod]` даёт поток STA, но не диспетчер WinUI, поэтому создание `Grid` в нём по-прежнему приводит к исключению. `[UITestMethod]` отправляет весь вызов MSTest в опубликованный `DispatcherQueue`, включая `[TestInitialize]` и `[TestCleanup]`:

```csharp
[UITestMethod]
public async Task GridCanBeCreatedOnTheUIThread()
{
    await Task.Yield();
    var grid = new Grid();
    Assert.IsTrue(grid.DispatcherQueue.HasThreadAccess);
}
```

Самая интересная строка здесь `await Task.Yield()`: продолжение возвращается в поток UI, поэтому асинхронные тесты сохраняют доступ к потоку.

## Пять моделей приложений, один SDK

[Руководство testfx](https://github.com/microsoft/testfx/blob/main/docs/winui-testing.md) охватывает классический UWP (`uap10.0`), современный UWP на .NET 10 с `UseUwp`, упакованный WinUI 3, неупакованный WinUI 3 (`WindowsPackageType=None`) и WinUI 3 с `TrustLevel="appContainer"`. Упакованные приложения и приложения в песочнице нельзя запустить через `Process.Start`, поэтому MSBuild запускает вспомогательный контроллер с полным доверием: он регистрирует пакет, активирует его по AUMID и после завершения приложения забирает из хранилища пакета TRX, дампы зависаний и результаты повторных запусков. Для AppContainer канал контроллера выдаёт доступ только точному SID пакета приложения и отклоняет `ALL APPLICATION PACKAGES`.

Теперь тестовый проект современного UWP выглядит так:

```xml
<Project Sdk="MSTest.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows10.0.26100.0</TargetFramework>
    <UseUwp>true</UseUwp>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Неупакованные и упакованные приложения с полным доверием запускаются командой `dotnet test --project MyWinUiTests.csproj -c Release -a x64`. UWP и AppContainer по-прежнему требуют MSBuild из Visual Studio: `msbuild MyUwpTests.csproj /t:InvokeTestingPlatform /p:Platform=x64`.

## Прежде чем фиксировать 4.5.0

В публикации в `global.json` зафиксировано `"MSTest.Sdk": "4.5.0"`, но на момент написания NuGet.org всё ещё показывает 4.4.1 как последнюю версию `MSTest.Sdk`. Проверьте фид, прежде чем обновлять CI. Также подготовьте агент CI: для упакованных запусков и запусков AppContainer нужен режим разработчика или политика загрузки неопубликованных приложений, тесты AppContainer должны выполняться без повышения прав, а среда выполнения Windows App SDK должна быть установлена на агенте.

Если вы уже используете MTP ради [генератора исходного кода для Native AOT в MSTest 4.4](/ru/2026/09/mstest-4-4-native-aot-source-generation/), то это тот же исполнитель, распространённый на последние модели приложений, которым ещё был нужен VSTest.
