---
title: "C# UnsafeAccessor: リフレクションを使わない private メンバーへのアクセス (.NET 8)"
description: ".NET 8 の UnsafeAccessor で既知の private コンストラクター、メソッド、プロパティ、フィールドにアクセスする検証済み例とバージョン制限。"
pubDate: 2023-10-31
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 で導入された `UnsafeAccessorAttribute` は、`static extern` メソッドを既知のアクセス不可メンバーに結び付けます。実装はランタイムが提供します。宣言元の型とシグネチャをコンパイル時に把握している場合に使えますが、実行時にメンバーを探索するリフレクションの代替ではありません。

**2026年11月2日訂正:** 元の記事はオーバーロードを不可とし、static アクセスにもインスタンスが必要だと誤って説明していました。以下で訂正しています。復元した例は .NET 8.0.33 で実行しました。性能は一律にオーバーヘッドゼロとせず、別途扱います。

## 完全なサンプルをダウンロード

[実行可能なソース ZIP](/examples/unsafe-accessor.zip)、または[実行手順](/examples/#unsafe-accessor)を参照してください。プロジェクト、宣言元の型、imports、および以下の各アクセス方法の確認処理を含みます。

```sh
dotnet run -c Release
```

プログラムは期待値を検証し、不一致なら失敗として終了します。成功時の表示は次のとおりです。

```text
PASS: constructors, instance/static members, field access, readonly accessor observation
```

## private コンストラクターとオーバーロード

ヘルパークラスでは通常の C# メソッドのオーバーロードが可能です。コンストラクターの accessor は宣言元の型を返し、対象コンストラクターの引数を受け取ります。

```cs
using System.Runtime.CompilerServices;

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create();

    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create(string value);
}
```

これらは `Foo()` と `Foo(string)` に対応します。完全な `Foo` 型は ZIP に含まれます。トップレベルのローカル関数とヘルパークラスのメソッドでは C# の名前の規則が異なりますが、これは `UnsafeAccessor` 自体の制約ではありません。

## インスタンスメソッドとプロパティ

最初の引数は宣言元の型を特定し、インスタンスを渡します。それ以降の引数型と戻り値型は対象に一致させます。プロパティは accessor メソッド経由で操作します。

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
internal static extern string CallInstance(Foo instance, int value);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
internal static extern string GetProperty(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
internal static extern void SetProperty(Foo instance, string value);
```

サンプルは private メソッドの結果、プロパティの初期値、書き込み後の値を確認します。struct のインスタンスメンバーでは、最初の引数を `ref` で渡す必要があります。

## static メンバー

`StaticMethod` または `StaticField` を使います。最初の引数は宣言元の型を特定するために必要ですが、**値は使われず**、null を渡せます。

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
internal static extern string CallStatic(Foo? typeMarker, int value);

var result = Accessors.CallStatic(null, 42);
```

この例の宣言元は static クラスではありません。C# では static クラスを引数の型にできないため、この .NET 8 のパターンで任意の static クラス API にアクセスできるとは限りません。

## フィールド

フィールドの accessor は参照を返します。サンプルではインスタンスと static の両方のフィールドを読み書きします。

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
internal static extern ref int InstanceField(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
internal static extern ref int StaticField(Foo? typeMarker);
```

readonly フィールドについては[専用の例](/ja/2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor/)を参照してください。フィールドへの参照を得られても、不変状態を任意に変更する設計がサポートされることにはなりません。

## 制限と性能

探索対象は指定した宣言元の型だけで、継承階層はたどりません。存在しないフィールドやメソッドへのバインドは、使用時にエラーになります。シグネチャや制約が不一致の場合もバインドに失敗することがあります。ジェネリック型パラメーターへの対応は .NET 9 で追加されたため、ジェネリックの例では別途バージョンを確認してください。

accessor はリフレクションの検索や `Invoke` の引数処理を避けられますが、呼び出す処理と生成コードのコストは残ります。[復元したベンチマーク](/ja/2023/11/net-8-performance-unsafeaccessor-vs-reflection/)は、観測可能な処理を使って直接呼び出し、キャッシュしたリフレクション、キャッシュしたデリゲートも比較します。

出典: [Microsoft の UnsafeAccessorAttribute リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute)。
