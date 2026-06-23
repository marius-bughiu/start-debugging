---
title: ".NET 11 Preview 5 で file-based app が `#:ref` を使って互いを参照できるようになりました"
description: ".NET 11 Preview 5 は #:ref ディレクティブを追加し、dotnet run スクリプトが別の file-based app をライブラリとして参照できるようにします。推移的な参照に対応し、プロジェクトファイルは不要です。"
pubDate: 2026-06-23
tags:
  - "dotnet"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/06/dotnet-11-preview-5-file-based-apps-ref-directive"
translatedBy: "claude"
translationDate: 2026-06-23
---
file-based app は、プロジェクトなしで単一の `.cs` ファイルを `dotnet run` で実行する方法として始まりました。[.NET 10 では `#:include` を覚え](/ja/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/)、追加のファイルを 1 つのコンパイルに取り込めるようになりました。[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) はさらに一歩進みます。新しい `#:ref` ディレクティブにより、ある file-based app が別の file-based app を*ライブラリ*として参照できるようになり、推移的な参照もサポートされます。`.csproj` は不要です。

## `#:ref` が `#:include` とどう違うか

この違いは本質的なものであり、見た目だけのものではありません。`#:include` は別のファイルを同じコンパイル単位にマージするため、すべてが 1 つのアセンブリに収まります。`#:ref` は対象を別個のライブラリとして扱って参照します。これは `ProjectReference` が行うのと同じですが、どちらの側にもプロジェクトが存在しません。

つまり `#:ref` は本物の境界を与えてくれます。参照されるファイルはそれ自体でコンパイルされ、その public な型を公開し、利用側はそれに対してリンクします。ヘルパーをコピー＆ペーストしたり、クラスライブラリを用意したりすることなく、スクリプト間での再利用が得られます。

## 実行できる 2 ファイルの例

`lib.cs` に小さなライブラリを置きます。

```csharp
// lib.cs
namespace MyLib;

public static class Greeter
{
    public static string Greet(string name) => $"Hello, {name}!";
}
```

`app.cs` からそれを参照します。

```csharp
// app.cs
#:ref lib.cs

Console.WriteLine(MyLib.Greeter.Greet("World"));
```

.NET 11 Preview 5 の SDK で実行します。

```bash
dotnet run app.cs
```

もし `lib.cs` 自体が 3 つ目のファイルへの `#:ref` を持っていれば、その参照は流れていきます。推移的な参照が解決されるため、プロジェクトの小さなグラフを構成するのと同じように、スクリプトの小さなグラフを構成できます。

## ディレクティブはもうゲートされていません

Preview 5 のもう 1 つのニュースは、file-based app のディレクティブ `#:include`、`#:exclude`、`#:project` が feature flag を必要としなくなり、include されたファイル内のディレクティブが推移的に処理されるようになったことです。そのため `#:include` はネストしたファイルまで到達でき、`#:project` はスクリプトのみの構成では手に余るようになったときにスクリプトを本物の `.csproj` に向けられます。

これは崖ではなく勾配を与えてくれます。1 つのファイルから始めます。`#:include` でヘルパーを切り出します。`#:ref` でヘルパーを再利用可能なライブラリに昇格させます。それがスクリプトでなくなったら `#:project` で完全なプロジェクトを取り込みます。各ステップはディレクティブ 1 行であり、どれも `dotnet run` の使用をやめさせるものではありません。

## これがどこに当てはまるか

`#:ref` は file-based app の他の作業と同じ層を対象にしています。tooling のスクリプト、サンプル、再現、そしてソリューションファイルに値したことのない類のグルーコードです。新しい境界は、MSBuild の儀式を引きずることなく、そうしたスクリプトを共有可能にします。これはプレビュー機能なので、.NET 11 Preview 5 の SDK で試し、頼りにする前に正確な挙動について [SDK のリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md)を読んでください。
