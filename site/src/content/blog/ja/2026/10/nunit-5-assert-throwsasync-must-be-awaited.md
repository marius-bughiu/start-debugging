---
title: "NUnit 5: Assert.ThrowsAsync は Task を返すようになり、await し忘れたテストは黙って成功します"
description: "NUnit 5.0.0 で Assert.ThrowsAsync、CatchAsync、DoesNotThrowAsync が本当の意味で非同期になりました。await を忘れるとアサーションは実行されません。何が壊れるのか、NUnit.Analyzers の NUnit2059 ルールが何を検出するのか、アップグレード前に確認すべき NUnit 5 のその他の変更点をまとめます。"
pubDate: 2026-10-04
tags:
  - "nunit"
  - "testing"
  - "dotnet"
  - "csharp"
lang: "ja"
translationOf: "2026/10/nunit-5-assert-throwsasync-must-be-awaited"
translatedBy: "claude"
translationDate: 2026-10-04
---

[NUnit 5.0.0](https://github.com/nunit/nunit/releases/tag/v5.0.0) は 2026-09-27 にリリースされました。メンテナーはこれを小規模なメジャーリリースと位置付けており、[破壊的変更](https://docs.nunit.org/articles/nunit/V5BreakingChanges.html)の多くは、ランタイムでの失敗をコンパイルエラーに変えるものです。ただし 1 つだけ逆方向の変更があります。不注意にアップグレードすると、失敗するはずのテストが成功し始める可能性があります。

## ThrowsAsync はブロックしていたが、今は Task を返す

NUnit 4 では、`Assert.ThrowsAsync<T>`、`Assert.CatchAsync`、`Assert.DoesNotThrowAsync` は名前こそ非同期でしたが、実際にはデリゲートを同期的に実行して呼び出し元のスレッドをブロックし、例外を直接返していました。[Issue #4384](https://github.com/nunit/nunit/issues/4384) がこれを 5.0.0 で修正し、3 つとも `Task` を返すようになったため、await が必要です。

```csharp
// NUnit 4.6.1
var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());

// NUnit 5.0.0
var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());
```

新しい形が正しい姿です。問題は、すでにあるコードです。

## 黙って成功する問題

古いテストは、通常の `void` テストメソッドから `ThrowsAsync` を呼び出しています。NUnit 5 でもこれはコンパイルが通ります。返された `Task` は破棄され、メソッドが `async` ではないため、コンパイラーは CS4014 すら出力しません。.NET SDK 10.0.302 と NUnit3TestAdapter 6.3.0 で、`DoesNotThrowAsync` が例外をスローしない状況を試しました。

```csharp
static async Task DoesNotThrowAsync() => await Task.Delay(10);

[Test]
public void Unawaited()
{
    var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}

[Test]
public async Task Awaited()
{
    var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}
```

結果は次のとおりです。

| 構成 | `Unawaited` | `Awaited` |
| --- | --- | --- |
| NUnit 4.6.1 | 失敗 (正しい動作) | CS1061, `ArgumentException` に `GetAwaiter` がない |
| NUnit 5.0.0, NUnit.Analyzers 4.13.0 | **成功** | 失敗 (正しい動作) |
| NUnit 5.0.0, NUnit.Analyzers 4.14.0 または 4.15.0 | ビルドエラー NUnit2059 | 失敗 (正しい動作) |

注意すべきなのは中央の行です。`ArgumentException` が発生しないことを検出するはずのテストが緑になり、テスト出力にはアサーションが実行されなかったことを示すものが何もありません。

## 移行はアナライザーに任せる

[NUnit.Analyzers](https://www.nuget.org/packages/NUnit.Analyzers) 4.14.0 で NUnit2059 が追加されました。メッセージは "Method 'ThrowsAsync' returns a Task and is not being observed" で、既定ではエラーとして報告されます。コード修正では `await` が追加され、外側のメソッドが `async Task` に変更されます。そのため、アップグレードの順序が重要です。

```xml
<PackageReference Include="NUnit" Version="5.0.0" />
<PackageReference Include="NUnit.Analyzers" Version="4.15.0" />
<PackageReference Include="NUnit3TestAdapter" Version="6.3.0" />
```

アナライザーは、フレームワークと同じコミットで更新してください。プロジェクトで NUnit.Analyzers のバージョンを `Directory.Packages.props` で一元管理していて古いバージョンに固定している場合や、パッケージを削除している場合は、ビルドは緑のままで、先ほどの黙って成功する行の状態になります。

## grep しておきたい NUnit 5 のその他の変更点

- `TestDelegate`、`AsyncTestDelegate`、`ActualValueDelegate<T>` は削除されました。ラムダ式には影響しません。明示的に使っている箇所は `Action`、`Func<Task>`、`Func<T>` に置き換えます。
- `[Platform("NET")]` と `"DotNET"` は、.NET Framework ではなく現行の .NET を意味するようになりました。.NET Framework を指していた場合は新しい `"NETFramework"` 識別子を使ってください。そうしないと、テストが意図しないランタイムで実行されたり、実行されなくなったりします。
- `Is.SameAs` は参照型のみを受け付け、`Has.Attribute<T>()` は `T : Attribute` を要求します。どちらも以前はランタイムでの失敗でした。
- `StringAssert`、`CollectionAssert`、`FileAssert`、`DirectoryAssert` は `NUnit.Framework` に戻されました。
- フレームワークのターゲットは `net462`、`net8.0`、`net10.0` です。`net6.0` ターゲットは削除されました。
- `[Order]` は `[Obsolete]` になりました。代わりに、依存先が失敗するとテストをスキップする新しい `[DependsOnTest]` と `[DependsOnFixture]` 属性を使います。

新規プロジェクトで NUnit がまだ適切なフレームワークかどうかを検討している場合は、私の [xUnit v3 vs NUnit vs MSTest の比較記事](/ja/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)が参考になります。この記事の計測は NUnit 4.6.1 で行いました。数値は 5.0.0 より前のものですが、推奨内容はこのリリースでの変更に左右されません。
