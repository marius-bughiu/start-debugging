---
title: "C# UnsafeAccessor: リフレクションなしでプライベートメンバーにアクセス (.NET 8)"
description: ".NET 8 の `[UnsafeAccessor]` 属性を使って、プライベートフィールドの読み取りやプライベートメソッドの呼び出しをオーバーヘッドゼロで行う方法を解説します。リフレクション不要、AOT にも完全対応。"
pubDate: 2023-10-31
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
リフレクションを使うと、実行時に型情報を取得し、その情報を使ってクラスのプライベートメンバーにアクセスできます。サードパーティーパッケージから提供されるなど、自分の管理下にないクラスを扱うときには特に便利です。強力ではあるものの、リフレクションは非常に遅く、それが利用をためらう主な理由のひとつでした。それも、もう過去の話です。

.NET 8 では、`UnsafeAccessor` 属性を使ってオーバーヘッドゼロでプライベートメンバーにアクセスする新しい方法が導入されました。この属性は `extern static` メソッドに付与できます。メソッドの実装は、属性の情報とメソッドのシグネチャに基づいてランタイムが提供します。指定した情報に一致するものが見つからない場合、メソッド呼び出しは `MissingFieldException` または `MissingMethodException` をスローします。

`UnsafeAccessor` の使い方をいくつかの例で見ていきましょう。次のようにプライベートメンバーを持つクラスを考えます。

```cs
class Foo
{
    private Foo() { }
    private Foo(string value) 
    {
        InstanceProperty = value;
    }

    private string InstanceProperty { get; set; } = "instance-property";
    private static string StaticProperty { get; set; } = "static-property";

    private int instanceField = 1;
    private static int staticField = 2;

    private string InstanceMethod(int value) => $"instance-method:{value}";
    private static string StaticMethod(int value) => $"static-method:{value}";
}
```

## プライベートコンストラクターを使ってインスタンスを生成する

上で説明したとおり、まずは `static extern` メソッドを宣言します。

-   メソッドに `UnsafeAccessor` 属性を付けます: `[UnsafeAccessor(UnsafeAccessorKind.Constructor)]`
-   そして、コンストラクターのシグネチャを一致させます。コンストラクターの場合、戻り値の型はリダイレクト先のクラスの型 (`Foo`) でなければなりません。パラメーターのリストも一致している必要があります。
-   extern メソッドの名前は何かに一致させる必要も、特定の規約に従う必要もありません。ひとつ重要な点として、同じ名前で異なるパラメーターを持つ `extern static` メソッドを 2 つ持つことはできません (オーバーロードに似ています) 。そのため、各オーバーロードには一意の名前を付ける必要があります。

最終的には、次のような形になるはずです。

```cs
[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructor();

[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructorWithParameters(string value);
```

ここまでくれば、プライベートコンストラクターを使ったインスタンス生成は簡単です。

```cs
var instance1 = PrivateConstructor();
var instance2 = PrivateConstructorWithParameters("bar");
```

## プライベートインスタンスメソッドを呼び出す

`extern static` メソッドの最初の引数は、そのプライベートメソッドを持つ型のオブジェクトインスタンスになります。残りの引数は対象メソッドのシグネチャと一致している必要があります。戻り値の型も一致していなければなりません。

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
extern static string InstanceMethod(Foo @this, int value);

Console.WriteLine(InstanceMethod(instance1, 42)); 
// Output: "instance-method:42"
```

## プライベートインスタンスプロパティの取得 / 設定

`UnsafeAccessorKind.Property` が存在しないことに気づくでしょう。これは、インスタンスメソッドと同様に、インスタンスプロパティもその getter / setter メソッド経由でアクセスできるためです。

-   `get_{PropertyName}`
-   `set_{PropertyName}`

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
extern static string InstanceGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
extern static void InstanceSetter(Foo @this, string value);

Console.WriteLine(InstanceGetter(instance1));
// Output: "instance-property"

InstanceSetter(instance1, "bar");

Console.WriteLine(InstanceGetter(instance1));
// Output: "bar"
```

## 静的メソッドとプロパティ

挙動はインスタンスメンバーとまったく同じで、唯一の違いは `UnsafeAccessor` 属性で `UnsafeAccessorKind.StaticMethod` を指定する必要がある点です。呼び出し時には、その型のオブジェクトインスタンスを渡す必要すらあります。

`static` クラスはどうでしょうか。静的クラスは現時点では `UnsafeAccessor` でサポートされていません。.NET 9 を見据えて、このギャップを埋めることを目指す API 提案が存在します: [\[API Proposal\]: UnsafeAccessorTypeAttribute for static or private type access](https://github.com/dotnet/runtime/issues/90081)

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
extern static string StaticMethod(Foo @this, int value);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "get_StaticProperty")]
extern static string StaticGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "set_StaticProperty")]
extern static void StaticSetter(Foo @this, string value);
```

## プライベートフィールド

フィールドは `extern static` メソッドの構文という観点で、もう少し特殊です。getter / setter メソッドが利用できないので、代わりに `ref` キーワードを使ってフィールドへの参照を取得し、その参照を読み取りにも書き込みにも使います。

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
extern static ref int InstanceField(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
extern static ref int StaticField(Foo @this);

// Read the field value
var x = InstanceField(instance1);
var y = StaticField(instance1);

// Update the field value
InstanceField(instance1) = 3;
StaticField(instance1) = 4;
```

この機能を試してみたいですか? 上で紹介した例はすべて [GitHub で公開](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor/Program.cs) されています。
