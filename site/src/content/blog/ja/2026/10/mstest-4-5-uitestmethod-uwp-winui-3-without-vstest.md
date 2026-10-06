---
title: "MSTest 4.5 は VSTest なしで UWP と WinUI 3 の UI テストを実行できます"
description: "MSTest.Sdk 4.5 と Microsoft.Testing.Platform 2.5 により、UWP や WinUI 3 アプリ自体がテストホストになります。[UITestMethod] は各テストを実際のディスパッチャー上で実行し、パッケージ化アプリと AppContainer アプリはサイドカーコントローラー経由で AUMID によりアクティブ化され、パッケージ化されていない WinUI もついに動作します。"
pubDate: 2026-10-06
tags:
  - "mstest"
  - "winui"
  - "uwp"
  - "testing"
  - "dotnet"
lang: "ja"
translationOf: "2026/10/mstest-4-5-uitestmethod-uwp-winui-3-without-vstest"
translatedBy: "claude"
translationDate: 2026-10-06
---

2026年10月5日、Amaury Levé 氏が ["UWP and WinUI 3 apps: UI testing with MSTest"](https://devblogs.microsoft.com/dotnet/testing-uwp-and-winui-3-apps-with-mstest/) を公開しました。要点は次のとおりです。`MSTest.Sdk` 4.5 (Microsoft.Testing.Platform 2.5 を含みます) を使えば、Windows XAML アプリでテストを実行するのに VSTest は不要になります。`Microsoft.NET.Test.Sdk` も `vstest.console` も、Visual Studio のインストールに含まれる `UwpTestHostRuntimeProvider` も必要ありません。

最後の点は見た目以上に重要です。VSTest は `UseWinUI` プロジェクトをすべてこのプロバイダー経由で処理し、ビルド出力から `AppxManifest.xml` を読み取っていました。パッケージ化されていない WinUI アプリにはマニフェストがないため、`FileNotFoundException` で失敗していました ([testfx#2784](https://github.com/microsoft/testfx/issues/2784))。MTP ではアプリ自体がテストホストになるため、この問題はなくなります。

## アプリが OnLaunched からプラットフォームをホストします

WinUI アプリは `ApplicationDefinition` から自前の `Main` をすでに生成します。`MSTest.Sdk` はそれを検出して独自のエントリポイントを抑止し、ウィンドウの作成後に一度呼び出すだけの `MicrosoftTestingPlatformApplication.RunAsync` ヘルパーを生成します。

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

生成される WinUI の `Main` は `void` を返すため、終了コードは手動で設定します。これを省略すると、何が失敗しても CI 上では成功として扱われます。

## STATestMethod ではなく UITestMethod を使います

`[STATestMethod]` は STA スレッドを提供しますが、WinUI のディスパッチャーは提供しません。そのため、そこで `Grid` を作成すると依然として例外がスローされます。`[UITestMethod]` は、`[TestInitialize]` と `[TestCleanup]` を含む MSTest の呼び出し全体を、公開された `DispatcherQueue` に送ります。

```csharp
[UITestMethod]
public async Task GridCanBeCreatedOnTheUIThread()
{
    await Task.Yield();
    var grid = new Grid();
    Assert.IsTrue(grid.DispatcherQueue.HasThreadAccess);
}
```

興味深いのは `await Task.Yield()` の行です。継続処理が UI スレッドに戻るため、非同期テストでもスレッドアクセスが維持されます。

## 5 つのアプリモデルを 1 つの SDK で扱えます

[testfx のガイド](https://github.com/microsoft/testfx/blob/main/docs/winui-testing.md)では、クラシック UWP (`uap10.0`)、`UseUwp` を使う .NET 10 上のモダン UWP、パッケージ化された WinUI 3、パッケージ化されていない WinUI 3 (`WindowsPackageType=None`)、そして `TrustLevel="appContainer"` を指定した WinUI 3 を扱っています。パッケージ化されたアプリやサンドボックス化されたアプリは `Process.Start` では起動できないため、MSBuild はフルトラストのサイドカーコントローラーを実行します。このコントローラーはパッケージを登録し、AUMID でアクティブ化し、終了後にパッケージのストレージから TRX、ハングダンプ、リトライの出力を収集します。AppContainer の場合、コントローラーのパイプはアプリの正確なパッケージ SID にアクセスを許可し、`ALL APPLICATION PACKAGES` は拒否します。

モダン UWP のテストプロジェクトは、今ではこれだけで済みます。

```xml
<Project Sdk="MSTest.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows10.0.26100.0</TargetFramework>
    <UseUwp>true</UseUwp>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

パッケージ化されていないアプリとフルトラストのパッケージ化アプリは、`dotnet test --project MyWinUiTests.csproj -c Release -a x64` で実行できます。UWP と AppContainer では、引き続き Visual Studio の MSBuild が必要です: `msbuild MyUwpTests.csproj /t:InvokeTestingPlatform /p:Platform=x64`。

## 4.5.0 を固定する前に

元の記事では `global.json` に `"MSTest.Sdk": "4.5.0"` を固定していますが、この記事の執筆時点で NuGet.org が最新の `MSTest.Sdk` として掲載しているのはまだ 4.4.1 です。CI を更新する前にフィードを確認してください。また、CI エージェントについても計画が必要です。パッケージ化アプリと AppContainer の実行には開発者モードまたはサイドロードのポリシーが必要で、AppContainer のテストは昇格なしで実行する必要があり、Windows App SDK のランタイムをエージェントにインストールしておく必要があります。

すでに [MSTest 4.4 の Native AOT ソースジェネレーター](/ja/2026/09/mstest-4-4-native-aot-source-generation/)のために MTP を使っているなら、今回の変更は同じランナーを、VSTest がまだ必要だった最後のアプリモデルまで拡張したものです。
