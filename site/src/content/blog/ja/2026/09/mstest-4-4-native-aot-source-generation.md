---
title: "MSTest 4.4 でリフレクション用ソースジェネレーターが正式版になり、Native AOT プロジェクトは自動で有効になります"
description: "MSTest 4.4 は MSTest.SourceGeneration を実験的な状態から外し、MSTest のバージョンに合わせます。Native AOT のテストプロジェクトはオプトインなしで取り込み、ReflectionFree モードは単純な [TestMethod] と [DataRow] について実行時の検出を省略できるようになり、5 つの AOTSG 診断がサポートされないテストの形を教えてくれます。"
pubDate: 2026-09-04
tags:
  - "mstest"
  - "native-aot"
  - "testing"
  - "source-generators"
  - "dotnet"
lang: "ja"
translationOf: "2026/09/mstest-4-4-native-aot-source-generation"
translatedBy: "claude"
translationDate: 2026-09-04
---

Microsoft は 2026-09-03 に ["Test what you ship: MSTest and Native AOT"](https://devblogs.microsoft.com/dotnet/mstest-source-generation/) を公開しました。タイトルの主張がそのまま要点です。アプリを `PublishAot` でデプロイしている場合、CI が検証してきたのはユーザーが実行するものとは別のバイナリです。テストホストはリフレクションが完全に使える CoreCLR 上で読み込まれるため、trimmer なら削除していたメンバーがアサーションの実行時にはまだ残っています。障害は代わりに本番で表面化します。

MSTest 4.3 は、その対策を独立したバージョンを持つ実験的なパッケージ `MSTest.SourceGeneration` として提供しました。MSTest 4.4 はこれを正式版にします。パッケージから experimental の表記が外れて MSTest のバージョン系列に移り、`MSTest.Sdk` が `MSTest.SourceGeneration`、`MSTest.TestFramework`、`MSTest.TestAdapter` のバージョンを `MSTestVersion` で揃えます。

## Native AOT プロジェクトはオプトインなしでジェネレーターを取り込みます

`PublishAot` を設定したテストプロジェクトは、ジェネレーターを自動的に取り込むようになりました。

```xml
<Project Sdk="MSTest.Sdk/4.4.0">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

テストコード自体は変わりません。通常の `[TestClass]` と `[TestMethod]` のメンバーはそのままで、ジェネレーターがレジストリ、属性データ、呼び出し用のデリゲートを、trimmer が動く前のコンパイル時に出力します。

`MSTest.Sdk` を使う Native AOT ではないプロジェクトでは、ジェネレーターはオプトインです。

```xml
<EnableMSTestSourceGeneration>true</EnableMSTestSourceGeneration>
```

これは再利用可能なテストライブラリでも、Central Package Management の下でも動作し、SDK が対応する `PackageVersion` 項目を生成します。.NET Standard では動作しません。必要な `MSTest.TestAdapter` のランタイムフックがそこには存在しないため、SDK は壊れたレジストリを作る代わりに明示的なエラーでビルドを失敗させます。

## コンパイル時の検出でルールが 1 つ変わります

検出がコンパイル時に行われるため、`[TestClass]` はクラス自身に宣言する必要があります。基底クラスからの継承はリフレクションでは動作していましたが、今は何も生成されず、警告もなく素通りします。アナライザー [MSTEST0069](https://learn.microsoft.com/en-us/dotnet/core/testing/mstest-analyzers/mstest0069) はまさにそのケースを検出します。これはビルド警告と、テスト 0 件を報告してグリーンで終わる CI 実行との違いになります。

## 4.4 の ReflectionFree が実際にカバーする範囲

`MSTestSourceGenMode` は MSTest 4.3.2 以降、trimming ありのプロジェクトと Native AOT プロジェクトで既定値が `ReflectionFree` です。リフレクションが使えるランタイムでは、ジェネレーターがカバーしなかった部分はフォールバックします。

4.4 はカバー範囲を広げます。リフレクション不要の生成は、`AttributeUsage` と `AllowMultiple` を含む継承された属性のメタデータを完全に実体化するようになり、[Microsoft.Testing.Platform](/ja/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) 上では、単純な同期の `[TestMethod]` と `[DataRow]` のメソッドについて実行時の検出と検証を完全に省略できます。非同期テスト、独自のテストメソッド属性、`DynamicData`、独自の `ITestDataSource` 実装、あいまいな形のテストは引き続きフォールバック経路を通ります。VSTest はいずれの場合も既存の経路を維持します。

リフレクション不要モードが生成できないものは、5 つの診断が示します。`AOTSG0001` は静的なテストクラス、`AOTSG0002` はオープンなジェネリックテストクラス (ジェネリック型に入れ子になったクラスを含む)、`AOTSG0003` は file-local や private の入れ子のように生成コードから到達できないクラス、`AOTSG0004` はジェネリックなテストメソッド、`AOTSG0005` は `ref`、`in`、`out` パラメーターを持つテストメソッドです。

何かが壊れて切り分けが必要になった場合は、検出は保ったままリフレクションによる実行に戻す逃げ道があります。

```xml
<PropertyGroup>
  <MSTestSourceGenMode>Rooting</MSTestSourceGenMode>
</PropertyGroup>
```

パイプラインを書き換える前に読んでおきたい注意点が 1 つあります。4.4 の動作は MSTest 4.4.0 がリリースされるまで、現時点ではプレビュービルドでのみ利用できます。プロパティの完全な一覧は [MSTest SDK の構成ドキュメント](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-sdk) にあります。
