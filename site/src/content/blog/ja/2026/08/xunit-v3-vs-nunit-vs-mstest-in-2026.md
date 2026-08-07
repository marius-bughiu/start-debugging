---
title: "xUnit v3 vs NUnit vs MSTest 2026年版: どれを選ぶべきか"
description: "新規の .NET プロジェクトには xUnit v3、制約モデルに慣れているなら NUnit 4.6、すでに使っているなら MSTest 4 を選びます。.NET SDK 10.0.201 上で実測した比較です。並列実行のデフォルト、テストクラスのライフサイクル、アサーション失敗時の出力、そして NUnit のランナーを壊す Microsoft.Testing.Platform のバージョン競合を扱います。"
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "testing"
  - "xunit"
  - "nunit"
  - "mstest"
  - "dotnet"
lang: "ja"
translationOf: "2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026"
translatedBy: "claude"
translationDate: 2026-08-07
---

2026年に新しい .NET プロジェクトを始めるなら **xUnit v3** を選んでください。デフォルトで並列実行し、失敗メッセージは3つの中で最も精密で、.NET チーム自身が使っているものです。テストが制約モデルや `[Retry]` に依存しているなら **NUnit 4.6** を選んでください。すでに MSTest を使っていて困っていないなら **MSTest 4** のままで構いません。v4 が差のほとんどを埋めたからです。

以下の数値はすべて .NET SDK 10.0.201 (ランタイム 10.0.5) 上で、xunit.v3 3.2.2、NUnit 4.6.1 と NUnit3TestAdapter 5.1.0、MSTest 4.3.3 を対象に実測したものです。この記事の挙動に関する主張はすべて changelog を読むのではなくコードを実行して検証しました。この3つのフレームワークについて広く信じられている内容の多くは、すでに古くなっているからです。

## 機能マトリクス

| 挙動 (検証したバージョン) | xUnit v3 3.2.2 | NUnit 4.6.1 | MSTest 4.3.3 |
| --- | --- | --- | --- |
| デフォルトで並列 | はい、コレクション単位で | いいえ、オプトイン | いいえ、オプトイン |
| テストごとに新しいクラスインスタンス | はい | いいえ、fixture ごとに1つ | はい |
| テスト属性 | `[Fact]` / `[Theory]` | `[Test]` / `[TestCase]` | `[TestMethod]` / `[DataRow]` |
| クラスへのマーカー属性が必要 | いいえ | いいえ | はい、`[TestClass]` |
| アサーションのスタイル | `Assert.Equal` | 制約、`Assert.That(x, Is...)` | `Assert.AreEqual`、`Assert.That` |
| 失敗した式をそのまま出力 | いいえ | はい | はい |
| `Assert.Multiple` | はい | はい | いいえ |
| 組み込みのリトライ属性 | いいえ | はい、`[Retry(n)]` | はい、`[Retry(n)]` |
| プロジェクトの種類 | 常に Exe | NUnit ランナー使用時は Exe | MSTest ランナー使用時は Exe |
| Microsoft.Testing.Platform | ネイティブ、組み込み | アダプター 5.0+ 経由 | 3.2 以降ネイティブ |
| 最小ターゲット | .NET 8 / .NET Framework 4.7.2 | .NET 6 / .NET Framework 4.6.2 | .NET 8 / .NET Framework 4.6.2 |

この表のうち2行は、ほとんどの比較記事が書いている内容と矛盾します。どちらも独立した節に値します。

## どこでも間違っているインスタンスライフサイクルの説明

この比較で最も繰り返される説明は、xUnit はテストごとに新しいテストクラスのインスタンスを生成し、NUnit と MSTest は1つのインスタンスを使い回す、というものです。その半分は誤りです。MSTest は以前からテストメソッドごとに新しいインスタンスを構築しています。

属性以外は3つのプロジェクトで同一の検証コードです。

```csharp
// MSTest 4.3.3, .NET 10.0.201
[TestClass]
public class LifecycleTests
{
    private static int _instances;
    private readonly int _id;
    public LifecycleTests() { _id = Interlocked.Increment(ref _instances); }

    private void Record(string n) =>
        File.AppendAllText(Log, $"{n} ctorId={_id} totalInstances={_instances}");

    [TestMethod] public void A() => Record("A");
    [TestMethod] public void B() => Record("B");
    [TestMethod] public void C() => Record("C");
}
```

3つそれぞれを実行した結果です。

```text
# xunit.v3 3.2.2
A ctorId=3 totalInstances=3
B ctorId=1 totalInstances=1
C ctorId=2 totalInstances=2

# MSTest 4.3.3
A ctorId=1 totalInstances=1
B ctorId=2 totalInstances=2
C ctorId=3 totalInstances=3

# NUnit 4.6.1
A ctorId=1 totalInstances=1
B ctorId=1 totalInstances=1
C ctorId=1 totalInstances=1
```

xUnit と MSTest はどちらも3つのインスタンスを構築しました。NUnit は1つだけ構築して共有しています。NUnit がこの3つの中では例外であり、可変なインスタンスフィールドがあるテストから次のテストへ状態を持ち越してしまうのは NUnit だけです。

これは聞こえる以上に重い話です。fixture ごとに1インスタンスという構成は、`[Order]` に依存したテストが静かに育っていく典型的な環境で、並列実行との相性も悪いです。同じ fixture の2つのテストが同時に走った瞬間、インスタンスフィールドは共有された可変状態になります。NUnit 自身のドキュメントもそう述べていて、NUnit 3.13 で復活した回避策を用意しています。

```csharp
// NUnit 4.6.1
[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]
public class LifecycleTests { /* ... */ }
```

この属性を付けると、同じ検証コードは `ctorId=1`、`2`、`3` を出力します。NUnit を使っていて並列実行を有効にするつもりなら、その前にアセンブリレベルでこれを適用してください。なお `OneTimeSetUp` と `OneTimeTearDown` は `static` にする必要があります。単一のインスタンスを持たなくなった fixture に対して一度だけ実行されるようになるためです。

## 並列実行のベンチマーク

これが唯一の実質的な性能差であり、その中身は完全にデフォルト設定の問題です。

**構成**: テストクラス4つ、各5テスト、すべてのテストで `Thread.Sleep(200)`。合計20テストなので、厳密に逐次実行した場合の下限は 4.0 秒、クラス単位で完全に並列化した場合の下限は 1.0 秒になります。Release ビルドで、Microsoft.Testing.Platform 経由のテスト実行ファイルとして直接起動し、ウォームアップ後3回の実行の実時間を計測しました。Intel Core Ultra 7 265KF (20コア、20論理プロセッサ)、Windows 11、.NET SDK 10.0.201 です。

| フレームワーク | デフォルト設定 | クラスレベルの並列を有効化 |
| --- | --- | --- |
| xunit.v3 3.2.2 | 1.29 - 1.32 秒 | 1.29 - 1.32 秒 (すでにデフォルト) |
| NUnit 4.6.1 | 4.71 - 4.73 秒 | 1.53 - 1.64 秒 |
| MSTest 4.3.3 | 4.80 - 4.89 秒 | 1.66 - 1.69 秒 |

このテスト群では、そのままの状態で xUnit は NUnit より 3.6 倍、MSTest より 3.7 倍高速です。よく引用されるのがこの数字です。しかしこれは誤解を招きます。測っているのはデフォルト設定であって能力ではないからです。アセンブリレベルの属性1つで、その差のほとんどは消えます。

```csharp
// NUnit 4.6.1
[assembly: Parallelizable(ParallelScope.Fixtures)]
```

```csharp
// MSTest 4.3.3
[assembly: Parallelize(Workers = 0, Scope = ExecutionScope.ClassLevel)]
```

これらを入れると、3つとも 1.29 秒から 1.69 秒の範囲に収まります。残る 240 から 380 ミリ秒の幅はランナーの起動オーバーヘッドであって、テストの実行時間ではありません。xUnit v3 は Microsoft.Testing.Platform をネイティブにホストしますが、NUnit 4.6.1 は NUnit3TestAdapter 内の VSTest ブリッジ経由で到達するため、起動時にわずかにコストがかかります。

つまり正直な整理はこうなります。xUnit の強みは、安全なデフォルトがそのまま高速なデフォルトになっている点で、それが安全なのはテストごとのインスタンスモデルのおかげです。NUnit と MSTest はオプトインを要求し、NUnit では先に fixture のライフサイクルを直すべきです。12分かかる MSTest のテストを CI が3年間逐次実行しているのなら、必要なのは1行であってマイグレーションではありません。

## アサーション失敗時の出力を並べて比較

かつては一方的な差でした。今はそうではありません。同じ3つの失敗に対する、各ランナーの実際の出力です。

```text
# xunit.v3 3.2.2
Assert.Equal() Failure: Strings differ
                  ↓ (pos 7)
Expected: "hello world"
Actual:   "hello wurld"
                  ↑ (pos 7)

Assert.Equal() Failure: Collections differ
                 ↓ (pos 2)
Expected: [1, 2, 3, 8]
Actual:   [1, 2, 4, 8]
                 ↑ (pos 2)
```

```text
# NUnit 4.6.1
Assert.That("hello wurld", Is.EqualTo("hello world"))
String lengths are both 11. Strings differ at index 7.
Expected: "hello world"
But was:  "hello wurld"
------------------^

Assert.That(actual, Is.EqualTo(expected))
Expected and actual are both <System.Int32[4]>
Values differ at index [2]
Expected: 3
But was:  4
```

```text
# MSTest 4.3.3
Assertion failed. Expected strings to be equal.
Strings have same length (11) and differ at 1 location(s). First difference at index 7.

expected: "hello world"
actual:   "hello wurld"

Assert.AreEqual("hello world", "hello wurld")
```

3つとも正確なインデックスを指しています。NUnit と MSTest 4 はどちらも失敗したソース式をそのまま出力しますが、xUnit は出力しません。MSTest 4 がすべての `Assert` API に `CallerArgumentExpression` を追加し、NUnit は 4.0 以降それを備えているからです。xUnit は視覚的な位置マーカーで補っており、長い文字列やコレクションではそちらのほうが読みやすいです。

MSTest が今も見劣りするのはコレクションの場合です。`CollectionAssert.AreEqual` は "Element at index 2 do not match" と出力するだけで、どちらのシーケンスも表示しません。インデックスは分かっても差分の形は分かりません。コレクションを頻繁に比較するなら、これは実際に効いてくる不便さです。

MSTest 4 のアサーションを書く前に知っておきたい API の細かい点が2つあります。`Assert.That` は `bool` ではなく `Expression<Func<bool>>` を取るため、`Assert.That(1 + 1 == 2)` はコンパイルできず、`Assert.That(() => 1 + 1 == 2)` ならコンパイルできます。また MSTest には `Assert.Multiple` がありません。xUnit v3 と NUnit 4.6 にはどちらもあります。

## 選択を決めてしまう落とし穴

.NET SDK 10.0.201 上でネイティブの NUnit ランナーを使って NUnit プロジェクトを今日立ち上げると、こうなります。

```text
error CS1705: Assembly 'NUnit3.TestAdapter' with identity 'NUnit3.TestAdapter, Version=5.1.0.0'
uses 'Microsoft.Testing.Platform, Version=1.8.1.0' which has a higher version than referenced
assembly 'Microsoft.Testing.Platform' with identity 'Microsoft.Testing.Platform, Version=1.7.3.0'
```

NUnit3TestAdapter 5.1.0 は Microsoft.Testing.Platform 1.8.1 に対してコンパイルされていますが、パッケージグラフのどこもその依存関係を宣言していないため、SDK が注入するバージョン 1.7.3 が勝ちます。プロジェクトはビルドできません。対処は、両方のプラットフォームアセンブリを自分で固定することです。

```xml
<!-- NUnit 4.6.1 + NUnit3TestAdapter 5.1.0 on .NET SDK 10.0.201 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <EnableNUnitRunner>true</EnableNUnitRunner>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="NUnit" Version="4.6.1" />
  <PackageReference Include="NUnit3TestAdapter" Version="5.1.0" />
  <PackageReference Include="Microsoft.Testing.Platform" Version="1.8.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.VSTestBridge" Version="1.8.1" />
</ItemGroup>
```

固定は両方必要です。`Microsoft.Testing.Platform` だけを追加するとエラーは消えますが、`Microsoft.Testing.Extensions.VSTestBridge` に対する MSB3277 の競合警告が残ります。両方入れればビルドはクリーンになります。

同等の xUnit v3 と MSTest 4 のプロジェクトには固定が一切不要です。どちらのフレームワークもプラットフォームへの依存を最後まで自分で持っているからです。

```xml
<!-- xunit.v3 3.2.2 on .NET SDK 10.0.201: this is the whole file -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="xunit.v3" Version="3.2.2" />
</ItemGroup>
```

この `PackageReference` 1行だけという構成が、3つの中で最もすっきりしています。NUnit のランナーは MTP の外套をまとった VSTest 上のブリッジであり、その継ぎ目は触れば分かります。CLI にも表れていて、xUnit v3 はハイフン1つの独自クエリ言語 (`-filter "/*/*/FailingTests/*"`) を使い、NUnit ランナーは VSTest 構文 (`--filter "FullyQualifiedName~FailingTests"`) を取り、MSTest は MTP のグラフクエリを取ります。1つのプラットフォーム上に3つのフレームワーク、3つのフィルター方言です。

## それぞれが今も勝っている場面

**xUnit v3 3.2.2 を選ぶのは**、.NET 8 以降で新規に始める場合です。テストごとのインスタンスモデルは順序依存のバグを書く前に一掃し、並列実行は指示しなくても有効で、v3 には実際に役立つ追加が入りました。実行時スキップのための `Assert.Skip`/`Assert.SkipWhen`、`MatrixTheoryData`、`[assembly: AssemblyFixture(...)]` によるアセンブリ fixture、そして紛れ込んだ `Console.WriteLine` をテスト出力に転送する `[CaptureConsole]` です。

**NUnit 4.6.1 を選ぶのは**、チームがすでに制約で考えている場合です。`Assert.That(items, Has.Exactly(1).EqualTo(2).And.Length.EqualTo(3))` の組み立て方は他の2つにはないもので、`[TestCase]`、`[Values]`、`[Combinatorial]` はパラメーター化テストを `[Theory]` や `[DataRow]` より網羅的にカバーします。3つの中で唯一 .NET 6 をまだサポートしている点も、取り残されたプロジェクトがあるなら効いてきます。上記の MTP の固定作業を見込んでおき、fixture のライフサイクルは明示的に設定してください。

**MSTest 4.3.3 を選ぶのは**、すでに MSTest を使っている場合です。v4 は保守ではなく本物のリリースです。すべての assert への `CallerArgumentExpression`、`Assert.ThrowsExactly`、プロジェクトをまたいでアセンブリのセットアップを共有する `AssemblyFixtureProvider` (4.3.0 の新機能)、そして MTP 配下ではデフォルトで無効になった AppDomain 分離があり、Microsoft はこれを最大 30% の高速化として計測しています。v4 はバイナリ互換ではなく .NET Core 3.1 から .NET 7 を切り捨てるため v3 からの移行は無料ではありませんが、アナライザーとコード修正が機械的な作業のほとんどを引き受けます。

## 私なら実際にどうするか

2026年の新規プロジェクトなら xUnit v3 です。デフォルト設定が正しい設定であることはテストフレームワークに求めたい性質そのもので、パッケージ1つで済むプロジェクトファイルには反論しにくいです。

既存の NUnit や MSTest のテストがあるなら、そのままで構いません。並列実行を有効にした後の3つの実測差は、20テストの構成で起動オーバーヘッド 400 ミリ秒未満です。これは移行を正当化する数字ではありません。その午後は代わりに `[assembly: Parallelizable(ParallelScope.Fixtures)]` (と `[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]`) または `[assembly: Parallelize(...)]` を追加することに使ってください。得られる利益のほぼすべてを回収できます。

フレームワークの選択は2022年に比べて2026年ではずっと重要度が下がりました。3つすべての下に Microsoft.Testing.Platform が入ったからです。ランナー、レポート、CI 連携、CLI は収束しつつあります。選ぶ余地として残っているのはライフサイクルモデルとアサーションの方言であり、これらは好みの問題です。ただし正しさに関わる実質的な帰結が1つだけあります。NUnit の共有される fixture インスタンスです。

## 関連記事

- ASP.NET Core のテストを組むなら、[`WebApplicationFactory<T>` を使った統合テスト](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)から始めてください。3つのフレームワークすべてで同じように動きます。
- フェイクではなく本物のデータベースが必要なテストについては、[Testcontainers で実際の SQL Server に対して統合テストを実行する方法](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)をご覧ください。
- 時刻に依存するテストは、もう1つのよくある不安定さの原因です。[`TimeProvider` と `FakeTimeProvider` によるテスト](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)を参照してください。
- レポート側では、[Microsoft.Testing.Platform 2.3 が失敗を PR の差分上に表示します](/ja/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)。どのフレームワークが生成した失敗かは問いません。
- フレームワークに依存しないテスト手法をもう2つ。[`HttpClient` を使うコードのユニットテスト](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)と[変更追跡を壊さずに `DbContext` をモックする方法](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)です。

## 参考リンク

- [What's New in xUnit.net v3](https://xunit.net/docs/getting-started/v3/whats-new) と [Microsoft Testing Platform support in xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
- テストごとのインスタンスモデルについては [xUnit.net shared context documentation](https://xunit.net/docs/shared-context)
- [NUnit `FixtureLifeCycle` documentation](https://docs.nunit.org/articles/nunit/writing-tests/attributes/fixturelifecycle.html)
- [NUnit and Microsoft.Testing.Platform](https://docs.nunit.org/articles/vs-test-adapter/NUnit-And-Microsoft-Test-Platform.html)
- [MSTest migration from v3 to v4](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-migration-v3-v4) と [MSTest test lifecycle](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-writing-tests-lifecycle)
- [Microsoft.Testing.Platform: now supported by all major .NET test frameworks](https://devblogs.microsoft.com/dotnet/mtp-adoption-frameworks/)
- NuGet 上のパッケージバージョン: [xunit.v3 3.2.2](https://www.nuget.org/packages/xunit.v3)、[NUnit 4.6.1](https://www.nuget.org/packages/NUnit)、[MSTest 4.3.3](https://www.nuget.org/packages/MSTest)
