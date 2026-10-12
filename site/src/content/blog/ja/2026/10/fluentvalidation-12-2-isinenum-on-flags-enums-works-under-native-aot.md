---
title: "FluentValidation 12.2 で [Flags] 列挙型の IsInEnum() が native AOT アプリをクラッシュさせる問題が修正されました"
description: "2026-10-10 にリリースされた FluentValidation 12.2.0 は EnumValidator 内の Enum.GetValues を Enum.GetValuesAsUnderlyingType に置き換えたため、[Flags] 列挙型に対する IsInEnum() が native AOT バイナリで NotSupportedException をスローしなくなりました。"
pubDate: 2026-10-12
tags:
  - "fluentvalidation"
  - "native-aot"
  - "dotnet"
  - "csharp"
  - "validation"
lang: "ja"
translationOf: "2026/10/fluentvalidation-12-2-isinenum-on-flags-enums-works-under-native-aot"
translatedBy: "claude"
translationDate: 2026-10-12
---

[FluentValidation 12.2.0](https://github.com/FluentValidation/FluentValidation/releases/tag/12.2.0) は 2026-10-10 に NuGet で公開されました。変更履歴の大半は細かな整備 (リトアニア語とベラルーシ語のメッセージ、`PropertyChain` の修正がいくつか) ですが、`PublishAot` で公開している場合に非常に重要な一行があります。"Change EnumValidator to work under native AOT" です。このリリース以前は、`[Flags]` 列挙型に対する `RuleFor(x => x.Access).IsInEnum()` はコンパイルが通り、JIT ベースのテストもすべて通過するのに、公開したネイティブバイナリでは最初の検証呼び出しでクラッシュしていました。

## クラッシュの様子

最小限のアプリを示します。権限やオプションの列挙型を検証する、AOT で公開された minimal API ならどこにでもある形です。

```csharp
using FluentValidation;

var v = new GrantValidator();
Console.WriteLine(v.Validate(new Grant(Access.Read | Access.Write)).IsValid);
Console.WriteLine(v.Validate(new Grant((Access)64)).IsValid);

[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Delete = 4 }

public record Grant(Access Access);

public class GrantValidator : AbstractValidator<Grant>
{
    public GrantValidator() => RuleFor(x => x.Access).IsInEnum();
}
```

.NET 10.0.302 SDK (osx-arm64) で `<PublishAot>true</PublishAot>` を指定して、FluentValidation 12.1.1 と 12.2.0 のそれぞれで公開しました。12.1.1 ではバイナリが即座に落ちます。

```text
Unhandled exception. System.NotSupportedException: 'Access[]' is missing native code or metadata.
   at System.Array.CreateInstance(Type, Int32) + 0x5c
   at System.RuntimeType.GetEnumValues() + 0x88
```

12.2.0 では同じコードが `True` と `False` を出力します。これは有効な組み合わせと未定義のビットに対する正しい結果です。

## [Flags] 列挙型だけが影響を受けた理由

`EnumValidator` には 2 つの経路があります。フラグでない列挙型は `Enum.IsDefined` を通り、これは以前から AOT セーフです。フラグ列挙型はプライベートメソッド `EvaluateFlagEnumValues` を通り、宣言されたすべての値からマスクを組み立てます。12.1.x ではこれを `Enum.GetValues(Type)` で行っていました。このオーバーロードは実行時に `Access[]` を割り当てる必要があるため `[RequiresDynamicCode]` が付いており、ILC は静的に一度も見ていない配列型を事前生成できません。

公開時に警告は出ていましたが、目立たないものでした。既定ではトリマーがサードパーティの警告を 1 行にまとめてしまいます。

```text
warning IL3053: Assembly 'FluentValidation' produced AOT analysis warnings.
```

`-p:TrimmerSingleWarn=false` を指定して初めて、`EnumValidator.cs(103)` と `Enum.GetValues(Type)` を指す本当の `IL3050` が見えます。

## 1 行の修正

[PR #2371](https://github.com/FluentValidation/FluentValidation/pull/2371) はこの呼び出しを `Enum.GetValuesAsUnderlyingType(enumType)` に置き換えます。これは .NET 8 から利用でき、.NET 8 は FluentValidation 12 の最小ターゲットです。値を基になる整数型としてボックス化して返すため、列挙型の配列は作成されず、既存の `Convert.ToInt64` ループもそのまま動作します。API の変更も動作の変更もなく、さらに値ごとのボックス化とアンボックス化の往復が 1 回減ります。

```csharp
// FluentValidation 12.2.0, EnumValidator.EvaluateFlagEnumValues
foreach (var enumValue in Enum.GetValuesAsUnderlyingType(enumType)) {
    var enumValueAsInt64 = Convert.ToInt64(enumValue);
    // ...
}
```

12.2.0 では、このサンプルにおいて FluentValidation の `IL3053` 警告が公開出力から完全に消えます。

## 知っておきたいもう 1 つの修正

12.2.0 では `RuleForEach` の `.When()` 内での `context.PropertyPath` も修正されています ([#2363](https://github.com/FluentValidation/FluentValidation/pull/2363))。以前は条件の実行後にコンテキストが更新されていたため、条件からは前の要素のパス (最初の要素では `null`) が見えていました。条件内で `PropertyPath` からエラーキーやログ行を組み立てている場合、1 つずれたパスを受け取っていたことになります。

## 対応方法

パッケージを更新します。

```bash
dotnet add package FluentValidation --version 12.2.0
```

native AOT を出荷している場合は、少なくとも一度は CI で `TrimmerSingleWarn` を `false` に設定してください。まとめられた `IL3053` の行こそが、今回のようなバグが本番環境に届く経路です。また、ASP.NET Core 11 でそもそも FluentValidation が必要かどうかを検討中であれば、[minimal API の検証と FluentValidation の比較](/ja/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) で組み込みの選択肢と比較しています。
