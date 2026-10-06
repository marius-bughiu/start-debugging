---
title: "MSTest 4.5 executa testes de UI de UWP e WinUI 3 sem VSTest"
description: "MSTest.Sdk 4.5 e Microsoft.Testing.Platform 2.5 fazem do próprio app UWP ou WinUI 3 o host de testes. [UITestMethod] executa cada teste no dispatcher real, apps empacotados e AppContainer são ativados por AUMID por meio de um controlador sidecar, e o WinUI não empacotado finalmente funciona."
pubDate: 2026-10-06
tags:
  - "mstest"
  - "winui"
  - "uwp"
  - "testing"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/10/mstest-4-5-uitestmethod-uwp-winui-3-without-vstest"
translatedBy: "claude"
translationDate: 2026-10-06
---

Em 5 de outubro de 2026, Amaury Levé publicou ["UWP and WinUI 3 apps: UI testing with MSTest"](https://devblogs.microsoft.com/dotnet/testing-uwp-and-winui-3-apps-with-mstest/). Resumindo: com o `MSTest.Sdk` 4.5 (que traz o Microsoft.Testing.Platform 2.5), apps XAML do Windows não precisam mais do VSTest para executar testes. Sem `Microsoft.NET.Test.Sdk`, sem `vstest.console`, sem `UwpTestHostRuntimeProvider` vindo da instalação do Visual Studio.

Esse último ponto importa mais do que parece. O VSTest roteava todo projeto `UseWinUI` por esse provider, que lê o `AppxManifest.xml` da saída da compilação. Um app WinUI não empacotado não tem manifesto, então falhava com `FileNotFoundException` ([testfx#2784](https://github.com/microsoft/testfx/issues/2784)). Com o MTP, o app é o host de testes, e o problema desaparece.

## O app hospeda a plataforma a partir de OnLaunched

Um app WinUI já gera seu próprio `Main` a partir de `ApplicationDefinition`. O `MSTest.Sdk` detecta isso, suprime o próprio ponto de entrada e gera um helper `MicrosoftTestingPlatformApplication.RunAsync` que você chama assim que a janela existe:

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

O `Main` do WinUI gerado retorna `void`, e é por isso que o código de saída é definido manualmente. Se você pular isso, o CI vê uma execução verde, não importa o que tenha falhado.

## UITestMethod, não STATestMethod

`[STATestMethod]` dá a você uma thread STA, mas não um dispatcher do WinUI, então criar um `Grid` nela ainda lança exceção. `[UITestMethod]` envia a chamada inteira do MSTest para o `DispatcherQueue` publicado, incluindo `[TestInitialize]` e `[TestCleanup]`:

```csharp
[UITestMethod]
public async Task GridCanBeCreatedOnTheUIThread()
{
    await Task.Yield();
    var grid = new Grid();
    Assert.IsTrue(grid.DispatcherQueue.HasThreadAccess);
}
```

A linha interessante é `await Task.Yield()`: a continuação volta para a thread de UI, então testes assíncronos mantêm o acesso à thread.

## Cinco modelos de app, um SDK

O [guia do testfx](https://github.com/microsoft/testfx/blob/main/docs/winui-testing.md) cobre UWP clássico (`uap10.0`), UWP moderno no .NET 10 com `UseUwp`, WinUI 3 empacotado, WinUI 3 não empacotado (`WindowsPackageType=None`) e WinUI 3 com `TrustLevel="appContainer"`. Apps empacotados e em sandbox não podem ser iniciados com `Process.Start`, então o MSBuild executa um controlador sidecar de confiança total que registra o pacote, o ativa por AUMID e coleta TRX, dumps de travamento e a saída de retentativas do armazenamento do pacote depois que ele termina. Para AppContainer, o pipe do controlador concede acesso ao SID exato do pacote do app e rejeita `ALL APPLICATION PACKAGES`.

Um projeto de teste UWP moderno agora é assim:

```xml
<Project Sdk="MSTest.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows10.0.26100.0</TargetFramework>
    <UseUwp>true</UseUwp>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Apps não empacotados e apps empacotados de confiança total executam com `dotnet test --project MyWinUiTests.csproj -c Release -a x64`. UWP e AppContainer ainda precisam do MSBuild do Visual Studio: `msbuild MyUwpTests.csproj /t:InvokeTestingPlatform /p:Platform=x64`.

## Antes de fixar a versão 4.5.0

O post fixa `"MSTest.Sdk": "4.5.0"` no `global.json`, mas, no momento em que escrevo, o NuGet.org ainda lista a 4.4.1 como a mais recente do `MSTest.Sdk`. Verifique o feed antes de atualizar o CI. Planeje também o agente de CI: execuções empacotadas e em AppContainer exigem o Modo de Desenvolvedor ou uma política de sideloading, os testes em AppContainer devem rodar sem elevação, e o runtime do Windows App SDK precisa estar instalado no agente.

Se você já usa o MTP pelo [gerador de código-fonte Native AOT no MSTest 4.4](/pt-br/2026/09/mstest-4-4-native-aot-source-generation/), este é o mesmo executor estendido para os últimos modelos de app que ainda precisavam do VSTest.
