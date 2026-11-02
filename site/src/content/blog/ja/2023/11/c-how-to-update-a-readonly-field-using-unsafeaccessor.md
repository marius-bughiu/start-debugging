---
title: "C#: UnsafeAccessor で readonly フィールドを書き換える"
description: "UnsafeAccessor で readonly フィールドを参照として公開する実行可能な .NET 8 の例。変更の制約と観測された動作を区別します。"
pubDate: 2023-11-02
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 の unsafe accessor は、`readonly` と宣言されたものも含め、インスタンスフィールドへの参照を返せます。その参照経由の書き込みは通常の C# 代入規則を迂回します。ただしフィールドの宣言は変わらず、不変状態に対する最適化された読み取り全般の動作が保証されるわけではありません。

**2026年11月2日訂正:** 取得できなくなったサンプルを復元しました。一般化された性能の主張と、直接読み取りが必ず返すとした結果を削除し、検証例では accessor を通して値を確認します。

## 実行可能な例

[完全なサンプルをダウンロード](/examples/unsafe-accessor.zip)できます。private メンバーの例に加え、次の readonly の例を含みます。

```cs
using System.Runtime.CompilerServices;

var holder = new ReadonlyHolder();
Accessors.ReadonlyField(holder) = 42;
Console.WriteLine(Accessors.ReadonlyField(holder)); // 42 in the verified run

internal sealed class ReadonlyHolder
{
    public readonly int Value = 3;
}

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "Value")]
    internal static extern ref int ReadonlyField(ReadonlyHolder instance);
}
```

ダウンロードしたプロジェクトを `dotnet run -c Release` で実行します。完全版は .NET 8.0.33 で初期値、書き込み、accessor による結果を確認しています。

## この例で確認できること

シグネチャはフィールドの宣言元の型、名前、型に一致しています。`ref int` を返すため、上の代入が可能になります。ただし別の参照からの書き込み、並行変更、すべての JIT/AOT 最適化が同じ結果になるとは限りません。別の場所での直接読み取りを、変更が一般的にサポートされるという保証にしてはいけません。

アプリの状態には、コンストラクターでの初期化や明示的に変更可能な API を優先してください。リフレクションによるインスタンスフィールドへの書き込みと static readonly フィールドではランタイム上の制限も異なり、同じケースとして扱えません。

通常の accessor は[メンバーアクセスの解説](/ja/2023/10/unsafe-accessor/)、呼び出し経路の測定は[ベンチマークプロジェクト](/ja/2023/11/net-8-performance-unsafeaccessor-vs-reflection/)を参照してください。[公式 API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute)にはシグネチャとバージョン制限があります。
