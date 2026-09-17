---
title: "MSTest 4.4.1 が、4.4.0 で C# 14 未満において壊れた CS0121 のあいまいな Assert 呼び出しを修正"
description: "MSTest 4.4.0 は Assert.Contains と Assert.DoesNotContain に Span<T> と ReadOnlySpan<T> のオーバーロードを追加しました。その結果、net8.0、net9.0、または C# 14 未満のあらゆるプロジェクトで、ごく普通の配列や文字列のアサーションが CS0121 で失敗するようになりました。2026-09-16 に公開された MSTest 4.4.1 は、配列に完全一致するオーバーロードと制約付きのフォワーダーを追加します。ただし、明示的なジェネリック引数を指定する 2 つの呼び出し形式は依然として失敗します。"
pubDate: 2026-09-17
tags:
  - "mstest"
  - "testing"
  - "csharp"
  - "dotnet"
  - "breaking-changes"
lang: "ja"
translationOf: "2026/09/mstest-4-4-1-fixes-cs0121-ambiguous-assert-calls-below-csharp-14"
translatedBy: "claude"
translationDate: 2026-09-17
---

`net8.0` または `net9.0` をターゲットにしたプロジェクトで MSTest を 4.4.0 に上げた場合、何年も変更していない行でテストプロジェクトがコンパイルできなくなっているかもしれません。2026-09-16 に NuGet に公開された [MSTest 4.4.1](https://github.com/microsoft/testfx/releases/tag/v4.4.1) がこれを修正します。ここでは、何が壊れたのか、私が計測したバージョンごとの結果、そして 4.4.1 でもまだカバーされていない 2 つの呼び出し形式を説明します。

## C# 14 でしか優先順位を決められない Span オーバーロード

MSTest 4.4.0 は、`Assert.Contains` と `Assert.DoesNotContain` に既存の `IEnumerable<T>` のオーバーロードと並べて `Span<T>` と `ReadOnlySpan<T>` のオーバーロードを追加しました。C# 14 では、ファーストクラスの span 変換によって配列と文字列に対するタイブレークのルールがコンパイラーに与えられるため、オーバーロードが 1 つに決まります。C# 14 未満では、`T[]` から `Span<T>` への変換はユーザー定義の `op_Implicit` にすぎず、どちらのオーバーロードも優位になりません。4.4.0 がリリースされた翌日に、[Issue #11022](https://github.com/microsoft/testfx/issues/11022) でこの問題が報告されました。

```text
error CS0121: The call is ambiguous between the following methods or properties:
'Assert.Contains<T>(T, System.Collections.Generic.IEnumerable<T>, string?, string, string)' and
'Assert.Contains<T>(T, System.Span<T>, string?, string, string)'
```

`net8.0` の既定は C# 12、`net9.0` の既定は C# 13 なので、これらの TFM は何も設定しなくても壊れます。古い `LangVersion` に固定した `net10.0` プロジェクトも同様です。

## バージョンごとの結果

SDK 10.0.302 を使い、同じファイルを各バージョンに対してコンパイルしました。

```csharp
int[] ids = [1, 2, 3];
string name = "Marius";

Assert.Contains(2, ids);
Assert.DoesNotContain(4, ids);
Assert.DoesNotContain('z', name);
Assert.Contains<int>(2, ids);
```

| MSTest | ターゲット / 言語 | 結果 |
| --- | --- | --- |
| 4.3.3 | `net8.0`、`net10.0` | ビルド成功 |
| 4.4.0 | `net10.0` (C# 14) | ビルド成功 |
| 4.4.0 | `net8.0`、`net9.0`、または `LangVersion` 12 の `net10.0` | `CS0121` が 4 件 |
| 4.4.0 | `LangVersion` 14 の `net8.0` | ビルド成功 |
| 4.4.1 | `net8.0`、`net10.0` | ビルド成功 |

4.4.0 では、明示的な `Contains<int>` や `string` のケースも含め、4 つの呼び出しすべてが失敗します。4.4.0 での唯一の回避策は古い TFM で `LangVersion` を 14 に上げることですが、これはサポートされた組み合わせではありません。本当の修正はアップグレードです。

```xml
<PackageReference Include="MSTest" Version="4.4.1" />
```

`MSTest.Sdk` を使っている場合は、代わりに `global.json` か `Sdk="MSTest.Sdk/4.4.1"` 属性でバージョンを上げてください。

## 4.4.1 はどう修正し、何が対象外なのか

[PR #11038](https://github.com/microsoft/testfx/pull/11038) は、影響を受けるすべての `Assert` のメソッド群に、`T[]` に完全一致するオーバーロードを追加します。完全一致はどちらの変換よりも優先されるため、配列に対する型推論の呼び出しも明示的な呼び出しも再び解決できるようになります。さらに、制約付きのフォワーダーも追加されており、`string`、`ArraySegment<T>`、独自のコレクションなど、span に変換できる他の型に対しても型推論の呼び出しが引き続き動作します。これらは既存の `IEnumerable<T>` のコードに転送するので、動作は 4.3.3 と同じです。

PR では、配列以外の型に対する明示的な `<T>` 呼び出しは対象外とされており、`net8.0` で 4.4.1 を使った私の検証結果もそれと一致します。

```csharp
var seg = new ArraySegment<int>(ids);
Assert.Contains(2, seg);           // OK
Assert.Contains(2, ids.AsSpan());  // OK
Assert.Contains<int>(2, seg);      // CS0121
Assert.Contains<char>('M', name);  // CS0121
```

型引数を削除して型推論にフォワーダーを選ばせるか、`IEnumerable<T>` にキャストしてください。

同じリリースでは、MSTest のソースジェネレーターがトリミングと Native AOT のためにルートとして保持する対象が絞り込まれ、列挙型、幅の狭い整数型、`NaN`、制御文字に対するソース生成リテラルも修正されています。[MSTest 4.4 でソースジェネレーターが正式版になった](/ja/2026/09/mstest-4-4-native-aot-source-generation/)あとにこれを有効にしたのであれば、それも 4.4.1 に上げるもう 1 つの理由になります。
