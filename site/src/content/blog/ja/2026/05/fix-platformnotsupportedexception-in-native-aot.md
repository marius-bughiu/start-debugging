---
title: "Fix: PlatformNotSupportedException: Operation is not supported on this platform (Native AOT)"
description: "Native AOT は JIT とインタープリターを取り除くため、reflection emit、式ツリーのコンパイル、未知の MakeGenericType は実行時に例外を投げます。IL3050 で呼び出しを特定し、ソースジェネレーターまたは事前生成された経路に置き換えます。"
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "native-aot"
  - "trimming"
lang: "ja"
translationOf: "2026/05/fix-platformnotsupportedexception-in-native-aot"
translatedBy: "claude"
translationDate: 2026-05-10
---

修正方法: Native AOT は JIT もインタープリターも持たない単一のネイティブバイナリを発行するため、実行時に IL を生成するコード経路、`Expression<T>` ツリーをコンパイルする経路、ランタイムにこれまで見たことのないジェネリックインスタンス化を作らせる経路はいずれも `PlatformNotSupportedException` を投げます。最初の一手は常に同じです。`dotnet publish -r <rid> -c Release` で再ビルドし、原因のメンバーを名指しする `IL3050` 警告を読み、AOT 互換の代替（ソースジェネレーター、事前インスタンス化されたジェネリック、または機能スイッチ）に置き換えます。

```text
System.PlatformNotSupportedException: Operation is not supported on this platform.
   at System.Reflection.Emit.DynamicMethod..ctor(String name, Type returnType, Type[] parameterTypes)
   at SomeLibrary.Internal.ExpressionCompiler.Compile(LambdaExpression expr)
   at SomeLibrary.PublicEntryPoint.DoTheThing()
   at Program.<Main>$(String[] args) in /src/Program.cs:line 12
```

```text
System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
   at System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(...)
   at System.Linq.Expressions.Compiler.LambdaCompiler.CompileLambda(LambdaExpression lambda, Boolean hasClosureArgument)
   at System.Linq.Expressions.Expression`1[[T]].Compile()
```

このガイドは .NET 11 SDK (preview 4)、`Microsoft.NET.Sdk` 11.0.0-preview.4、C# 14 を対象としています。例外の文言と背後にある制約は、Native AOT が .NET 8 でサポート対象のデプロイメントとして出荷されてから安定しているため、以下の内容は .NET 8、10、11 で変更なくそのまま当てはまります。.NET 9 では IL3050 を支える `RequiresDynamicCodeAttribute` のアナライザー周りが整備され、.NET 11 ではさらに多くの BCL の経路が AOT セーフな実装に置き換えられて締め付けが強化されています。

異なる 2 つのメッセージが同じ例外型を共有しています。`Operation is not supported on this platform` は JIT-emit のファストパスが `RuntimeFeature.IsDynamicCodeSupported == false` に当たって出るものです。`Dynamic code generation is not supported on this platform` は何かが `DynamicAssembly` または `DynamicMethod` を構築しようとしたときに `Reflection.Emit` 自身から出るものです。どちらも根本原因と修正の打ち手は同じなので、別々のバグとして扱って時間を浪費しないでください。

## 単一ファイルの Native AOT バイナリが IL を生成できない理由

`dotnet publish /p:PublishAot=true` は完全に事前コンパイルされたネイティブイメージを生成します。JIT は静的にリンクされていません。Mono インタープリターも静的にリンクされていません。CoreCLR の `Reflection.Emit` ライターはコンパイル時に取り除かれます。実行時に `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported` は `false` を返し、新しい IL の書き出しや、生のマシンコードからの新しいデリゲートの組み立てに依存するあらゆる API は、`IsSupported` 形式のガード失敗かこの例外のいずれかを返します。

実コードでこの制約に当たるパターンは 4 つです:

1. **`Reflection.Emit` の直接利用。** `DynamicMethod`、`AssemblyBuilder.DefineDynamicAssembly`、`TypeBuilder`、`ILGenerator.Emit`。これらは即座に例外を投げます。
2. **非自明なツリーに対する `Expression<T>.Compile()`。** 式コンパイラーは内部的に `DynamicMethod` まで降ろします。`Compile(preferInterpretation: true)` は .NET 8 と 10 ではインタープリターにフォールバックしますが、インタープリターも Native AOT からは取り除かれているため、BCL 側にツリーをたどるフォールバックがない限り `true` のオーバーロードでも例外が出ます。
3. **コンパイラーが見ていない型引数を伴う `Type.MakeGenericType` / `MethodInfo.MakeGenericMethod`。** `List<int>` は AOT コンパイラーがインスタンス化したので動きます。コンパイラーが到達していない値型に対する `MakeGenericType(someTypeFromReflection)` は例外を投げます。
4. **以上に積み重なるあらゆるもの。** AutoMapper の式コンパイル済みマッパー、FastMember、MediatR のオープンジェネリック、Newtonsoft.Json のコンバーターキャッシュ、model builder がカバーしていない POCO グラフ上の EF Core のコンパイル済みクエリ経路、古い codegen を使う gRPC.Core、そして動的プロキシに依存する Dataverse / Service Fabric / WCF のクライアント。

JIT ビルドではランタイムが新しいメソッドの tier-0 コードを生成して先に進みますが、Native AOT には新しいコードを置く場所がないため、API が呼び出された最初の瞬間に例外を投げます。

## 最小再現

```csharp
// .NET 11 SDK preview 4, C# 14, <PublishAot>true</PublishAot>
using System.Linq.Expressions;

Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();   // throws on Native AOT
Console.WriteLine(compiled(41));
```

`.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

Linux x64 で発行します:

```bash
dotnet publish -r linux-x64 -c Release
```

publish ステップは次のように出力します:

```text
warning IL3050: Using member 'System.Linq.Expressions.Expression`1<TDelegate>.Compile()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. Compiling a lambda requires dynamic code.
```

バイナリを実行します:

```text
Unhandled exception. System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
```

これがエラーの典型的な姿です。原因が自分のコードであっても、NuGet パッケージであっても、推移的に取り込まれたフレームワークの一部であっても、形は同じです。

## 修正方法、詳細

以下の修正は、コストの低いものから侵襲性の高いものへと並べてあります。最初にコンパイルが通るものを採用してください。

### 1. AOT 互換の代替に置き換える（推奨）

問題のある API のほぼすべてに、まさにこの例外クラスのために .NET チームが用意した AOT フレンドリーな置き換えがあります。

| AOT に敵対的 | AOT フレンドリーな置き換え |
|---|---|
| `Newtonsoft.Json` | `[JsonSerializable]` ソースジェネレーターのコンテキストを持つ `System.Text.Json` |
| `AutoMapper` (式コンパイル方式) | ソースジェネレートされたマッパー（Mapster の source-generator モード、Riok.Mapperly、`MapTo`） |
| `MediatR` (オープンジェネリック登録) | 手書きのハンドラー インターフェース、または `Mediator`（ソースジェネレーター版） |
| `Microsoft.AspNetCore.Mvc.Controllers` | `WebApplication.CreateSlimBuilder` + `JsonSerializerContext` を伴う minimal API |
| 実行時に構築される EF Core モデル | モデルを事前生成する `OptimizeQuery` / `dotnet ef dbcontext optimize` |
| `Castle.DynamicProxy` のインターセプター | ソースジェネレートされたデコレーター（Roslyn や PolySharp 経由など） |
| `Expression<T>.Compile()` | `delegate*<...>`、`Func<...>` リテラル、またはビルド時にコンパイルされる手書きの `IL` 置き換え |

ラムダのコンパイル呼び出しを置き換える具体例:

```csharp
// .NET 11, C# 14
// Before: AOT-hostile
Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();

// After: pure delegate, no expression tree, no Compile()
Func<int, int> compiled = x => x + 1;
```

ボディを検査するなど、本当に式ツリーの形が必要な場合はツリーは残しつつ、`Compile()` の呼び出しをやめて、消費側を自分で書いた `delegate` に切り替えます。

### 2. `RuntimeFeature.IsDynamicCodeSupported` を機能スイッチとして使う

動的経路がオプションであれば、ランタイムの機能フラグの背後にゲートし、遅いものの AOT セーフなフォールバックを出荷します:

```csharp
// .NET 11, C# 14
using System.Runtime.CompilerServices;

public static T Materialize<T>(IDataReader reader)
{
    if (RuntimeFeature.IsDynamicCodeSupported)
    {
        return EmitMaterializer<T>.Compile()(reader);   // existing fast path
    }

    return ReflectionMaterializer<T>.Materialize(reader); // slower but no IL emit
}
```

AOT コンパイラーは発行されるバイナリに対して `IsDynamicCodeSupported` を `false` として静的に評価し、`EmitMaterializer<T>` を含む動的分岐をまるごとトリミングして取り除きます。IL3050 はもう出ませんし、実行時の例外もありません。重要: アナライザーがトリミングするのは、テストがプロパティの直接的な読み取りである場合に限ります。先にローカル変数に代入したり、メソッドにラップしたりすると、トリマーは死んだ分岐を残してしまいます。

### 3. コンパイラーから見えないジェネリックを事前にインスタンス化する

メッセージが `MakeGenericType` または `MakeGenericMethod` を名指ししている場合、AOT コンパイラーはどの `T` を生成すればよいかを知りません。出口は 2 つあります:

```csharp
// .NET 11, C# 14
// Tell the AOT compiler exactly which generic instantiations to keep.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]
public class Repository<T> { /* ... */ }

// And in your DI bootstrap, use closed generics:
services.AddScoped<Repository<User>>();
services.AddScoped<Repository<Order>>();
// not: services.AddScoped(typeof(Repository<>));
```

純粋にリフレクションで呼んでいる場合は、ソースジェネレーター版の等価物に切り替えます。ASP.NET Core 11 は一般的な依存性注入の形について AOT セーフなオーバーロードを出荷していますし、ランタイム チームはパラメーターなしコンストラクター向けに AOT フレンドリーな `Activator.CreateInstance<T>()` のイントリンシックも追加しています。

### 4. メソッドに `RequiresDynamicCode` を付け、AOT 経路から呼び出さない

ライブラリを書いていてあるメソッドが本当に動的 codegen を必要とする場合、要件を呼び出し側へ伝播させて、アナライザーが呼び出し側のレベルで警告できるようにします:

```csharp
// .NET 11, C# 14
[RequiresDynamicCode("Builds a per-type accessor with Reflection.Emit. " +
                     "Not supported in Native AOT. Use SourceGenAccessor<T> instead.")]
public static Func<object, object> BuildGetter(PropertyInfo prop) => /* emit */;
```

属性は実行時例外そのものを直しはしませんが、無言のクラッシュをビルド時の IL3050 へと変換します。これこそが Native AOT の利用者が期待している契約です。

### 5. 依存関係を取り除く

最後の手段。依存しているライブラリが `Reflection.Emit` をハードコードしていて AOT モードを提供していない場合、誠実な選択肢は (a) ライブラリを置き換える、(b) そのサブシステムを非 AOT のプロセス境界の向こう（HTTP や named pipe の境界の背後にある JIT 発行のワーカー）に置く、(c) 上流のメンテナーが AOT 経路を出荷するのを待つ、しかありません。例外を `try/catch` で握り潰してはいけません。失敗した操作にほぼ確実に依存している消費側がいるため、プログラムは未定義の状態になります。

## よくある変種と紛らわしい例

- **`System.Linq.Expressions` から出る `PlatformNotSupportedException: System.Reflection.Emit.DynamicMethod`。** Compile() と同じ根本原因で、`Queryable` プロバイダーや JSON コンバーターの内部で表面化することが多いです。発行ログから、原因のメソッドを名指しする IL3050 行を探してください。JSON シリアライザー経由でここに来た場合は [AOT セーフな System.Text.Json コンバーターの書き方](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) を参照してください。
- **`Assembly.Load(byte[])` から出る `PlatformNotSupportedException: Operation is not supported on this platform`。** Native AOT は実行時に追加のマネージドアセンブリを読み込めません。フォールバックはありません。プラグインの読み込みは非 AOT のホストへ移してください。
- **`Castle.DynamicProxy` から出る `PlatformNotSupportedException: Cannot emit a dynamic assembly.`。** Castle は 5.x の時点で AOT 経路を持ちません。インターセプトをソースジェネレートされたデコレーターに置き換えるか、プロキシ対象のサービスを AOT バイナリの外へ追い出してください。
- **`NotSupportedException: BinaryFormatter serialization and deserialization are disabled.`** 例外型は異なりますが、「AOT バイナリから取り除かれた」という同じ大枠のテーマです。`try/catch` で囲ってはいけません。シリアライズを System.Text.Json に書き換えてください。
- **`PlatformNotSupportedException: ... requires the JIT.`** これはインタープリターも切られている Mono インタープリター ターゲット（iOS、watchOS、MAUI Catalyst）で見るメッセージです。修正の打ち手は Native AOT と同じです。ジェネリックを事前生成する、ソースジェネレーターに切り替える、機能スイッチで経路をガードする、のいずれかです。
- **エラーが特定のプラットフォームでだけ出る。** 一部のパッケージは RID ごとに NuGet ランタイム アセットを出荷します。`linux-x64` ビルドでは `Reflection.Emit` がスタブアウトされてコンパイルされ、`win-x64` では動く、ということがあり得ます。出荷するすべての RID で必ず publish をテストしてください。

## 本当に直ったかを確認する

勝利宣言の前に行う 3 つのチェック:

1. `dotnet publish -r <rid> -c Release` が `IL3050` 警告を一切出さない。`<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` と `<IsAotCompatible>true</IsAotCompatible>` を使ってエラーへ昇格させましょう。
2. 発行されたバイナリが、以前失敗していた経路を `DOTNET_TieredCompilation=0` と `DOTNET_ReadyToRun=0` の下で実行する。Native AOT はこれらの環境変数を尊重しませんが、誤って self-contained JIT ビルドをテストしていないことを素早く確認するための手段になります。
3. 発行されたバイナリのインポート テーブルに JIT (`clrjit.dll` / `libclrjit.so`) への参照が含まれていない。Linux ではバイナリに対して `nm --dynamic` をかけても `clrjit` シンボルは見えないはずです。

3 つすべてを通過すれば、AOT クリーンなバイナリができていて、同じ経路から例外が戻ってくることはありません。

## 関連

- [ASP.NET Core minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) は、典型的な Web サービスについて、発行の全経路と IL3050 警告の出方を一通り解説しています。
- [.NET 11 の AWS Lambda でコールドスタート時間を短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) は、多くのチームがそもそも Native AOT に手を出す理由そのものです。
- [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) は、`JsonSerializer` にリフレクション メタデータを渡したくなったときの AOT セーフな置き換えです。
- [INotifyPropertyChanged のソースジェネレーターを書く方法](/ja/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) は、既存ライブラリが代わりに `Reflection.Emit` をやろうとしている場面で使うパターンです。
- [Rider 2026.1 が JIT と Native AOT の出力をデコードする ASM ビューアーを搭載](/ja/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) は、トリマーが本当に動的分岐を取り除いたかを確かめたいときに役立ちます。

## 出典

- [Native AOT deployment overview, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [IL3050: Avoid calling members annotated with RequiresDynamicCodeAttribute when publishing as Native AOT, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/warnings/il3050)
- [Introduction to AOT warnings, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/fixing-warnings)
- [Intrinsic APIs marked RequiresDynamicCode, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/intrinsic-requiresdynamiccode-apis)
- [How to make libraries compatible with Native AOT, .NET Blog](https://devblogs.microsoft.com/dotnet/creating-aot-compatible-libraries/)
- [AOT with Reflection, dotnet/runtime discussion #95244](https://github.com/dotnet/runtime/discussions/95244)
- [RuntimeFeature.IsDynamicCodeSupported, .NET API browser](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.runtimefeature.isdynamiccodesupported)
