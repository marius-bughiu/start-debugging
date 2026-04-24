---
title: "C# で書く Node.js Addons: .NET Native AOT が C++ と node-gyp を置き換える"
description: "C# Dev Kit チームは C++ の Node.js addon を .NET 10 Native AOT ライブラリに入れ替え、N-API、UnmanagedCallersOnly、LibraryImport を使って Python や node-gyp なしで単一の .node ファイルを生成しました。"
pubDate: 2026-04-21
tags:
  - ".NET 10"
  - "Native AOT"
  - "C#"
  - "Node.js"
  - "Interop"
lang: "ja"
translationOf: "2026/04/nodejs-addons-dotnet-native-aot"
translatedBy: "claude"
translationDate: 2026-04-24
---

C# Dev Kit チームの Drew Noakes は [2026 年 4 月 20 日に発表しました](https://devblogs.microsoft.com/dotnet/writing-nodejs-addons-with-dotnet-native-aot/): 拡張機能のネイティブ Node.js addon が今や完全に C# で書かれ、.NET 10 Native AOT でコンパイルされていると。つまり拡張機能が依存する Windows Registry アクセスは `dotnet publish` が生成するプレーンな `.node` ファイルとして出荷され、C++ も、Python も、node-gyp もビルドチェーンにありません。

## これがなぜ Node ツーリングにとって大事なのか

Node.js addons は歴史的に C または C++ プロジェクトを node-gyp で貼り合わせたもので、node-gyp には Python、C++ toolchain、Windows では互換性のある MSBuild が必要でした。クロスプラットフォームの Electron 拡張を保守したことがある人なら、そのチェーンが CI でどれほど脆くなるか知っているはずです。Native AOT はパイプライン全体を単一の `dotnet publish` に畳み込み、プラットフォーム固有の shared library (`.dll`、`.so`、または `.dylib`) を生成します。`.node` にリネームすれば Node が直接ロードします。C# Dev Kit はまさにこのフローを使って Windows Registry を読み取り、コントリビューターのセットアップから Python を取り除いています。

## C# から napi_register_module_v1 をエクスポート

トリックは、N-API (Node-API) が安定した ABI を持っていることです。つまり C 呼び出し規約を持つネイティブエクスポートを生成できる言語なら、どれでも Node addon を実装できます。.NET 10 では `[UnmanagedCallersOnly]` がその仕事をします: AOT イメージにエクスポート名と呼び出し規約を固定します。Node が探すエントリポイントは `napi_register_module_v1` です。

```csharp
public static unsafe partial class HelloAddon
{
    [UnmanagedCallersOnly(
        EntryPoint = "napi_register_module_v1",
        CallConvs = [typeof(CallConvCdecl)])]
    public static nint Init(nint env, nint exports)
    {
        RegisterFunction(env, exports, "hello"u8, &SayHello);
        return exports;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static nint SayHello(nint env, nint info)
    {
        return CreateString(env, "Hello from .NET!");
    }
}
```

`"hello"u8` リテラルは UTF-8 バイト文字列で、これは N-API が欲しいものです。`&SayHello` は function pointer で、そのシグネチャでは `UnmanagedCallersOnly` が generics や async のような managed-only 機能を禁じているので AOT を生き残ります。

## ホストプロセスに対して N-API を解決する

パズルの後半は N-API に呼び戻すことです。リンクする `node.dll` は存在しません。多くのプラットフォームで Node バイナリは実行ファイル自身だからです。ポストは `[LibraryImport("node")]` と、現在のプロセスハンドルを返すカスタム `NativeLibrary.SetDllImportResolver` を併用し、すべての N-API 呼び出しがロード時に実行中の Node 実行ファイルに対して解決されるようにします。

```csharp
[LibraryImport("node", EntryPoint = "napi_create_string_utf8")]
private static partial int CreateStringUtf8(
    nint env, byte[] str, nuint length, out nint result);

NativeLibrary.SetDllImportResolver(typeof(HelloAddon).Assembly,
    (name, _, _) => name == "node"
        ? NativeLibrary.GetMainProgramHandle()
        : 0);
```

## プロジェクトファイル

AOT の有効化は 2 行の変更です。N-API interop は function pointer とネイティブメモリ上の span に頼るので `AllowUnsafeBlocks` が必要です。

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <PublishAot>true</PublishAot>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

`dotnet publish -c Release` 後、出力ライブラリを `HelloAddon.node` にリネームして、他のどんなネイティブモジュールとも同じように JavaScript から `require()` します。

より豊かなシナリオについて、ポストは [microsoft/node-api-dotnet](https://github.com/microsoft/node-api-dotnet) も指しています。これは N-API を高レベル抽象に包み、JS と CLR 型の間の完全な interop をサポートします。しかし「C++ toolchain なしで小さくて速いネイティブ addon を出荷する」ケースについては、生の N-API + Native AOT ルートが今や Microsoft 自身の VS Code 拡張内で production 実証済みです。
