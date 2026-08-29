---
title: "Fix: CA1070 \"Do not declare event fields as virtual\""
description: "CA1070 はフィールドライクイベントに virtual が付いていると発生します。virtual を外して非仮想のままにし、派生クラスには protected virtual な OnXxx を override させてください。"
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "analyzers"
  - "events"
lang: "ja"
translationOf: "2026/08/fix-ca1070-do-not-declare-event-fields-as-virtual"
translatedBy: "claude"
translationDate: 2026-08-29
---

CA1070 は、フィールドライクイベントに `virtual` 修飾子が付いているときに発生します。修正方法は `virtual` を外し、代わりに派生クラスが override できる `protected virtual void OnThresholdReached(...)` という発生メソッドを用意することです。これはスタイル上の細かい指摘ではありません。その仮想イベントを何かが override すると、コンパイラーは基底クラスと派生クラスにそれぞれ別々のプライベートなバッキングフィールドを与えるため、基底クラス側の発生処理は何も呼び出さずに黙って終わります。

探している診断メッセージは次のとおりです。

```text
warning CA1070: Event 'ThresholdReached' should not be declared virtual
```

以下の内容はすべて SDK `10.0.302` (.NET 10、C# 14) と SDK に同梱されているアナライザーで検証し、`dotnet/sdk` にある `DoNotDeclareEventFieldsAsVirtual` のソースコードと照合しています。

## dotnet build は CA1070 を報告しますか?

いいえ。既定の重要度は警告ではなく提案です。アナライザーが `RuleLevel.IdeSuggestion` で宣言されているためです。

```csharp
// dotnet/sdk, Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs
internal static readonly DiagnosticDescriptor Rule = DiagnosticDescriptorHelper.Create(
    RuleId,
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualTitle)),
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualMessage)),
    DiagnosticCategory.Design,
    RuleLevel.IdeSuggestion,
    ...
```

提案レベルの診断は Visual Studio、Rider、`dotnet format` には表示されますが、`dotnet build` は出力せず、`TreatWarningsAsErrors` の対象にもなりません。仮想イベントだらけのプロジェクトでも、ビルド結果はこうなります。

```text
    0 Warning(s)
    0 Error(s)
```

実際に効かせる方法は 2 つあります。

```xml
<!-- .NET 10 SDK 10.0.302: promotes the All-mode analyzers, CA1070 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
```

これは [CA1873 と高コストなログ引数](/ja/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/) とまったく同じ「見えない」罠です。CI で提案を昇格させる際のトレードオフについては [開発ビルドを壊さない TreatWarningsAsErrors](/ja/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/) で解説しています。

## そもそもなぜイベントに virtual を付けてしまうのですか?

ほとんどの場合、原因は CS0070 です。派生クラスは基底クラスのイベントを発生させられません。

```csharp
// .NET 10, C# 14
public class Sensor
{
    public event EventHandler? ThresholdReached;
}

public class LoggingSensor : Sensor
{
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}
```

```text
error CS0070: The event 'Sensor.ThresholdReached' can only appear on the left hand side
of += or -= (except when used from within the type 'Sensor')
```

コンパイラーは、宣言している型の外側ではイベントは add/remove のペアでしかなく、その背後にあるデリゲートではないと伝えています。ここで一見もっともらしい回避策が、イベントに `virtual` を付けて `LoggingSensor` で override し、その名前が派生クラス自身の持ち物に解決されるようにすることです。これはコンパイルは通ります。そして同時にイベントを壊します。

## 仮想のフィールドライクイベントを override するとなぜイベントが壊れるのですか?

基底クラスがイベントを発生させなくなるからです。不具合の全体を 1 つのファイルに収めると次のようになります。

```csharp
// .NET 10 (SDK 10.0.302), C# 14
using System;

public class Sensor
{
    public virtual event EventHandler? ThresholdReached;   // CA1070
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached;
    public void RaiseFromDerived() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public static class Program
{
    public static void Main()
    {
        LoggingSensor derived = new();
        Sensor asBase = derived;
        asBase.ThresholdReached += (_, _) => Console.WriteLine("handler ran");

        Console.WriteLine("Sensor.Raise():");
        asBase.Raise();                 // fires nothing
        Console.WriteLine("LoggingSensor.RaiseFromDerived():");
        derived.RaiseFromDerived();     // fires the handler
    }
}
```

.NET 10 での実際の出力です。

```text
Sensor.Raise():
LoggingSensor.RaiseFromDerived():
handler ran
```

同じオブジェクト、同じハンドラーなのに、一方の発生は動作し、もう一方は何もしません。

理由は、フィールドライクイベントが同時に 2 つの別物であり、そのうち仮想になるのは片方だけだからです。`add` と `remove` のアクセサーは実体のあるメソッドなので、`virtual` 修飾子が実際に付きます。背後にあるデリゲートフィールドには付きません。フィールドは仮想にできないからです。コンパイル済みアセンブリをリフレクションで覗くと、コンパイラーが何を出力したかがそのまま分かります。

```text
Sensor: field ThresholdReached, IsPrivate=True, type=EventHandler
Sensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=Sensor
LoggingSensor: field ThresholdReached, IsPrivate=True, type=EventHandler
LoggingSensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=LoggingSensor
```

型ごとに 1 つずつ、合計 2 つのプライベートフィールドがあります。したがって次のようになります。

- `asBase.ThresholdReached += handler` は仮想の add アクセサーを経由し、`LoggingSensor.add_ThresholdReached` にディスパッチされて `LoggingSensor` のフィールドに入ります。
- `Sensor.Raise()` はどのアクセサーも経由しません。宣言している型の内部では `ThresholdReached?.Invoke(...)` は `Sensor` 自身のプライベートフィールドを直接読むコードにコンパイルされ、その値は null のままです。

C# の仕様はこれを許容しています。仮想イベント宣言はアクセサーを仮想にし、override するイベント宣言は「新しいイベントを宣言するのではなく、既存のアクセサーの実装を特殊化するだけ」です。仕様の文言からすると、派生側のアクセサーは共有された 1 つのフィールドへのアクセスを特殊化すべきであり、そのためにはコンパイラーが基底のバッキングフィールドを private から protected に格上げする必要があります。しかしコンパイラーはそうしませんでした。Microsoft は 2007 年にこれを既知のコンパイラーのバグとして文書化し、修正しないことを決めました。修正すると、ハンドラーが決して呼ばれないことに暗黙のうちに依存していたコードで、その呼び出しが復活してしまうからです。

2007 年から変わったのは、この不具合がより静かになった点です。当時の再現コードは `myEvent(this, null)` を使っていて `NullReferenceException` を投げたので、少なくとも問題を指し示してくれました。あらゆるアナライザーやコード修正が勧めてくる現代の null 条件付き呼び出しは、これを黙って何もしない処理に変えてしまいます。

## MVVM の基底クラスではどう現れますか?

基底のビューモデルに `INotifyPropertyChanged` を書くときに手が伸びる形が、まさに壊れているケースです。

```csharp
// .NET 10, C# 14
public class ViewModelBase : INotifyPropertyChanged
{
    public virtual event PropertyChangedEventHandler? PropertyChanged;   // CA1070
    protected void Notify(string n) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

public class OrderViewModel : ViewModelBase
{
    public override event PropertyChangedEventHandler? PropertyChanged;
}
```

バインディングエンジンは `INotifyPropertyChanged` インターフェース経由で購読するため、仮想の add アクセサーに回され、ハンドラーは `OrderViewModel` に格納されます。`Notify` は `ViewModelBase` の内部で実行され、`ViewModelBase` のフィールドを読みます。.NET 10 で確認したところ、ハンドラーは一度も呼ばれませんでした。例外も出ず、出力ウィンドウにバインディングエラーも出ないまま、UI が単に更新されません。

派生ビューモデル側の `override` はたいてい名残であり、CS0070 を追いかけた誰かが足したか、テンプレートからコピーされたものです。これを削除するとバッキングフィールドが 1 つになるので、バインディングは即座に直ります。何かを書き直す前に確認する価値があります。通知の仕組みをゼロから作るのであれば、[INotifyPropertyChanged 用のソースジェネレーター](/ja/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) が正しい非仮想の形を出力するので、ここで間違えることはありません。

## CA1070 はどう修正しますか?

おすすめの順に説明します。

**1. 非仮想のイベントと protected virtual な発生メソッド。** これは .NET の設計ガイドラインが定める型であり、CA1070 が導こうとしている先でもあります。派生クラスは本来欲しかった拡張ポイントを得られ、バッキングフィールドはちょうど 1 つになります。

```csharp
// .NET 10, C# 14. Builds clean under AnalysisMode=All.
public class Sensor
{
    public event EventHandler? ThresholdReached;

    protected virtual void OnThresholdReached(EventArgs e)
        => ThresholdReached?.Invoke(this, e);

    public void Raise() => OnThresholdReached(EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    protected override void OnThresholdReached(EventArgs e)
    {
        Console.WriteLine("[derived saw the raise]");
        base.OnThresholdReached(e);
    }
}
```

発生メソッドはフィールドを読むので、宣言している型の中に置く必要がある点に注意してください。派生側の override は実際に発生させるために `base.OnThresholdReached(e)` を呼びます。`base` の呼び出しを忘れるとイベントを抑制したことになりますが、それが狙いである場合もあります。

**2. イベントは仮想のまま残し、protected なフィールドの上に明示的なアクセサーを書く。** 派生クラスが購読を本当に横取りする必要があるとき、たとえば最初の購読者が現れた時点で OS レベルのフックを遅延して張りたいときに使います。ルールが対象とするのはフィールドライクイベントだけなので、ここでは CA1070 は発生しません。

```csharp
// .NET 10, C# 14
public class Sensor
{
    protected EventHandler? _thresholdReached;

    public virtual event EventHandler? ThresholdReached
    {
        add => _thresholdReached += value;
        remove => _thresholdReached -= value;
    }

    public void Raise() => _thresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached
    {
        add { Console.WriteLine("[derived add]"); _thresholdReached += value; }
        remove => _thresholdReached -= value;
    }
}
```

デリゲートフィールドへの `+=` はアトミックではないので、購読者が複数のスレッドから来る可能性があるならアクセサー内で `Interlocked.CompareExchange` かロックを使ってください。私の実行では両方のハンドラーが正しく発生しました。どちらのアクセサーも同じ protected フィールドを指すようになったからです。

**3. 基底のイベントを abstract にする。** 抽象のフィールドライクイベントはフィールドのようには使えないため、基底クラスは物理的にそれを発生させられず、フィールドが分裂するバグも起こりえません。アナライザーが見るのは `IsVirtual` であり、これは抽象メンバーでは false になるので、CA1070 は発生しません。

```csharp
// .NET 10, C# 14
public abstract class Sensor
{
    public abstract event EventHandler? ThresholdReached;
    public abstract void Raise();
}
```

これは正しい形ですが、望ましい場面はまれです。派生クラスのすべてがイベントと発生処理を実装し直す必要が出てくるからです。

## CA1070 は実際にどの宣言を報告しますか?

基底の `virtual` 宣言だけです。そのため、実際に壊れている行を指してくれると期待してアナライザーを走らせた人は驚きます。チェックはシンボルに対する単一のアクションです。

```csharp
// dotnet/sdk, DoNotDeclareEventFieldsAsVirtual.cs
if (!eventSymbol.IsVirtual ||
    eventSymbol.AddMethod?.IsImplicitlyDeclared == false ||
    eventSymbol.RemoveMethod?.IsImplicitlyDeclared == false)
{
    return;
}
```

`IEventSymbol.IsVirtual` が true になるのは `virtual` キーワードで宣言されたメンバーだけです。`override` されたメンバーは `IsVirtual` ではなく `IsOverride` を返し、`abstract` なメンバーは `IsAbstract` を返します。つまり診断は基底の宣言に付き、それ以外の場所には付きません。`IsImplicitlyDeclared` のチェックは、ルールをフィールドライクイベントに限定するためのものです。アクセサーを自分で書いていればそれらは暗黙ではないので、ルールは何もせずに戻ります。

SDK 10.0.302 に対して `dotnet_diagnostic.CA1070.severity = warning` を設定して実際に流した、完全なマトリクスがこちらです。

| 宣言 | CA1070? |
| --- | :---: |
| `public virtual event EventHandler A;` | あり |
| `protected virtual event EventHandler B;` (public で sealed でないクラス内) | あり |
| `internal virtual event EventHandler C;` | なし |
| `public virtual event EventHandler D { add {} remove {} }` | なし |
| `public override event EventHandler A;` (派生クラス内) | なし |
| `public abstract event EventHandler E;` | なし |
| `public virtual event EventHandler F;` (`internal` クラス内) | なし |
| `public event EventHandler G;` (仮想ではない) | なし |

人がつまずく 2 行は internal に関するもので、これらは設定で変えられます。

## CA1070 で internal や private のイベントも対象にするには?

既定ではこのルールは外部から見えるシンボルだけを解析します。これは以前の FxCop の挙動に合わせたものです。対象を広げるには `api_surface` を設定します。

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
dotnet_code_quality.CA1070.api_surface = all
```

同じマトリクスで `api_surface = all` は A、B、C、F を報告します。`api_surface = private, internal` は C と F だけを報告します。公開ライブラリではなくアプリケーションのアセンブリであれば `all` が正しい設定です。そこには公開 API の契約など存在せず、このバグはアクセシビリティを気にしないからです。

知っておく価値のあるドキュメントの食い違いが 1 つあります。MS Learn のページは対象言語を "C# and Visual Basic" と記載していますが、アナライザーには `[DiagnosticAnalyzer(LanguageNames.CSharp)]` が付いており、"Construct is invalid in VB.NET" という抑制コメントが添えられています。VB にはそもそも `Overridable` なフィールドライクイベントが存在しないので解析する対象がありません。ドキュメントの表が単に古いだけです。

## CA1070 を抑制してよいのはどんなときですか?

その仮想イベントが、すでに出荷済みの公開 API の一部である場合です。`virtual` を外すのは、それを override していた人にとってバイナリ互換性を壊す変更なので、ルール自身のガイダンスも、利用者を壊すよりは抑制せよという内容です。プロジェクト全体ではなく宣言箇所で抑制し、メモを残してください。

```csharp
// Public since v2.0. Removing 'virtual' is a binary break for derived types.
#pragma warning disable CA1070
public virtual event EventHandler? ThresholdReached;
#pragma warning restore CA1070
```

そのうえで protected な発生メソッドも追加しておきます。そうすれば新しい派生型は正しい拡張ポイントを持てるようになり、`override` に手を伸ばさずに済みます。新しいコードベースや内部向けのコードベースでは抑制しないでください。修正してください。

## 間違ってここにたどり着きやすい落とし穴と類似ケース

**CS0070** ("The event 'X' can only appear on the left hand side of += or -=") は、人々に `virtual` を書かせてしまうコンパイルエラーで、上で扱いました。修正は protected な発生メソッドであって、仮想イベントではありません。

**CS0067** ("The event 'X' is never used") は、この記事のとおりに直して派生クラスからイベントを発生させるのをやめた時点で、派生側の `override` に出ます。この警告は、誰も書き込まないバッキングフィールドがアナライザーから見えている残像です。override を削除すれば消えます。

**CA1030** ("Use events where appropriate") と **CA1003** ("Use generic event handler instances") はイベントの形に関する設計ルールであり、仮想かどうかとは関係がなく、フィールドが分裂するバグとも無関係です。

**「Moq や Castle DynamicProxy に横取りさせるために virtual にしました」。** プロキシベースのモックライブラリが仮想メンバーを必要とするのは事実ですが、イベントの横取りは、そこに合わせることが本物のバグを埋め込む唯一のケースです。代わりにインターフェースをモックしてください。素の `event EventHandler ThresholdReached` を持つ `IThresholdSource` を切り出してモックに実装させれば、`virtual` はどこにも必要なくなります。EF Core の遅延読み込みプロキシのために基底クラスをまるごと仮想にした場合も同じで、実際に必要なのはナビゲーションプロパティだけです。

仮想イベントをすでに出荷してしまい、その影響を追っているのであれば、症状はたいてい、購読されたまま永久に呼ばれないハンドラーで、ヒープダンプではルートを持つデリゲートとして現れます。[dotnet-gcdump と dotnet-dump でマネージドメモリリークを診断する方法](/ja/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) では、生き残っているハンドラーの連鎖を見つける手順を解説しています。

CA1070 は .NET 5 のアナライザーから同梱されていて重要度は Info のままであり、一度も昇格していません。誰かが `override` と書いたときにだけ起爆するルールとしては妥当な判断ですが、それは「なぜバインディングが更新されないのか」で午後をつぶさずに済む可能性がもっとも高い警告を、ビルドが一度も出力しないという意味でもあります。これを警告に変えるコストは `.editorconfig` の 1 行です。

## 関連記事

- [Fix: CA1873 "Evaluation of this argument may be expensive and unnecessary if logging is disabled"](/ja/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/)
- [INotifyPropertyChanged 用のソースジェネレーターを書く方法](/ja/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/)
- [開発ビルドを壊さない TreatWarningsAsErrors (.NET 10)](/ja/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [ソースジェネレーターとは何か、どんなときに必要か?](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [dotnet-gcdump と dotnet-dump でマネージドメモリリークを診断する方法](/ja/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)

## 参考資料

- [CA1070: Do not declare event fields as virtual](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1070) (MS Learn)
- [DoNotDeclareEventFieldsAsVirtual.cs](https://github.com/dotnet/sdk/blob/main/src/Microsoft.CodeAnalysis.NetAnalyzers/src/Microsoft.CodeAnalysis.NetAnalyzers/Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs)、アナライザーのソースコード
- [Virtual events in C#](https://learn.microsoft.com/en-us/archive/blogs/samng/virtual-events-in-c)、コンパイラーのバグと修正しないという判断を記録した 2007 年の C# チームの記事
- [How to raise base class events in derived classes](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/events/how-to-raise-base-class-events-in-derived-classes) (MS Learn)
- [Handle and raise events](https://learn.microsoft.com/en-us/dotnet/standard/events/)、.NET のイベント設計ガイドライン
- [api_surface 構成オプション](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/code-quality-rule-options#api_surface) (コード品質ルール)
