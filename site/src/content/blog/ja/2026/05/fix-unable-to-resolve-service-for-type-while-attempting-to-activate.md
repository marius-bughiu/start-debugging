---
title: "解決方法: Unable to resolve service for type 'X' while attempting to activate 'Y'"
description: "ASP.NET Core は、コンストラクターが登録されていない型、別のコンテナーに登録された型、またはホストのビルド後に追加された型を要求した場合にこの例外をスローします。3 つの具体的な修正でほぼすべてのケースをカバーします。"
pubDate: 2026-05-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate"
translatedBy: "claude"
translationDate: 2026-05-10
---

解決方法: ASP.NET Core の `ActivatorUtilities` が `Y` のコンストラクターを走査し、`IServiceProvider` に `X` を要求しましたが、何も返ってきませんでした。`services.AddScoped<X, XImpl>()`(または `AddSingleton` / `AddTransient`)を呼び忘れたか、実装は登録したけれどコンテナーが知らないインターフェースや基底クラスを要求しているか、登録がホストが実際にビルドした `IServiceCollection` とは別のものに住んでいるかのいずれかです。`Program.cs` の `builder.Build()` の前に不足している登録を追加し、型名が完全に一致していることを再確認してください。

```text
System.InvalidOperationException: Unable to resolve service for type 'MyApp.Data.IUserRepository' while attempting to activate 'MyApp.Api.Controllers.UsersController'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.ConstructorMatcher.CreateInstance(IServiceProvider provider)
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.CreateInstance(IServiceProvider provider, Type instanceType, Object[] parameters)
   at Microsoft.AspNetCore.Mvc.Controllers.ServiceBasedControllerActivator.Create(ControllerContext context)
   at Microsoft.AspNetCore.Mvc.Controllers.ControllerActivatorProvider.<>c__DisplayClass4_0.<CreateActivator>b__0(ControllerContext controllerContext)
   at Microsoft.AspNetCore.Mvc.Infrastructure.ControllerActionInvoker.Next(State& next, Scope& scope, Object& state, Boolean& isCompleted)
```

このガイドは .NET 11 preview 4、`Microsoft.AspNetCore.App` 11.0.0-preview.4、`Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4 を対象に書かれています。例外のテキストは ASP.NET Core 2.1 以来安定しているため、以下の各修正は .NET Core 3.1、.NET 5、6、8、10 までそのまま適用できます。

メッセージ内の 2 つの型名が最も有用な部分です。**最初の**名前(`X`)はコンテナーが見つけられなかった型で、**2 つ目の**名前(`Y`)はそれを要求した消費者です。何かをする前にこの順序で読んでください。あなたをここに導いた検索クエリは半分の確率でメッセージの間違った半分にマッチするからです。

## なぜコンテナーは型を見つけられなかったのか

ほぼすべてのケースを 3 つの原因が説明します。

1. **その型に対する登録がまったくない**。`public UsersController(IUserRepository repo)` と書きましたが、`services.AddScoped<IUserRepository, UserRepository>()` を一度も呼び出していません。コンテナーにはインターフェースから実装へのマッピングがありません。
2. **間違ったキーで登録した**。`services.AddScoped<UserRepository>()`(具体型)を呼び出しましたが、コントローラーは `IUserRepository`(インターフェース)を要求しています。コンテナーは登録したものだけを、ジェネリックパラメーターまたは `serviceType` 引数として使われた厳密な型で解決します。
3. **別の `IServiceCollection` に登録した**。テストで、テストホストが独自のコレクションをビルドする場合や、`builder.Build()` の後に `builder.Services` を変更する珍しいケースでよくあります。ホストはビルド時にコレクションのスナップショットを取ります。

名前を挙げる価値のある、あまり一般的でないバリエーションがいくつかあります。一致する閉じた型なしで登録されたオープンジェネリック型(`AddScoped(typeof(IRepo<>), typeof(Repo<>))` は問題ありません。`AddScoped<IRepo<User>>(...)` は同じ登録ではありません)、キーなしの消費者から要求された `keyed` サービス、依存性注入が合成できない `Action` やファクトリー デリゲートをコンストラクターに渡したケースなどです。まずは最初の 3 つから取り組んでください。

## 最小再現

これは例外をスローする最小の .NET 11 minimal API です。

```csharp
// .NET 11 preview 4, Microsoft.AspNetCore.App 11.0.0-preview.4
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);

// Notice: no services.AddScoped<IUserRepository, UserRepository>();

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}
```

```csharp
// .NET 11 preview 4
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("users")]
public sealed class UsersController(IUserRepository repo) : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok(repo.GetName(id));
}
```

`GET /users/1` を呼ぶと、リクエストは上のセクションの例外で失敗します。コンテナーは `IUserRepository` を見たことがないため、MVC の `ServiceBasedControllerActivator` がコントローラーをビルドしようとすると、コンストラクター パラメーターを満たすことができません。

## 修正 1: 不足しているサービスを登録する

最初に試すべきことで、80% のケースで答えになります。

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

サービスの使い方に合うライフタイムを選びます。

- `AddScoped` は、リクエストごとの状態に触れるもの(EF Core の `DbContext`、`HttpContext` アクセサーのラッパー、テナント リゾルバー)に対する適切なデフォルトです。リクエスト スコープごとに 1 インスタンス。
- `AddSingleton` は、状態を持たないか、スレッドセーフな共有状態(キャッシュ、オプション、`IHttpClientFactory` 経由の HTTP クライアント)に対するものです。プロセスごとに 1 インスタンス。
- `AddTransient` は、毎回新しいコピーが欲しい安価で状態を持たないオブジェクト(`IValidator<T>`、マッパー)に対するものです。解決ごとに新しいインスタンス。

ここで間違うと、今日の例外を明日の `InvalidOperationException: Cannot consume scoped service ... from singleton ...` と交換するか、もっと悪いことに、2 つのリクエストが `DbContext` を共有する静かなスレッドセーフ バグと交換することになります。[Microsoft.Extensions.DependencyInjection ドキュメント](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines)の公式ガイダンスがリファレンスです。リクエスト スコープが存在する場合は、迷ったら `AddScoped` をデフォルトにしてください。

## 修正 2: コンストラクターが実際に要求するサービス型を登録する

登録があるのにまだ例外が出る場合、登録された型と消費される型が一致していません。コンストラクターと登録を照らし合わせてください。

```csharp
// Wrong: only the concrete type is registered
builder.Services.AddScoped<UserRepository>();

// Right: register both the interface and the implementation,
// or just the interface mapped to the implementation
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

コンテナーはインターフェースの推論を行いません。`UserRepository` が `IUserRepository` を実装していても、`UserRepository` だけを登録しても `IUserRepository` は登録されません。消費者がインターフェースを要求しているなら、インターフェースを登録してください。

本当に両方が必要な場合("ここでは `UserRepository` を、あちらでは `IUserRepository` を注入したい")、両方を登録し、インターフェースを具体型に転送します。

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<UserRepository>();
builder.Services.AddScoped<IUserRepository>(sp => sp.GetRequiredService<UserRepository>());
```

このパターンは、消費者が時に具体的な `MyOptions` を、時に `IOptions<MyOptions>` を要求するホストされたサービスとオプション パターンで重要です。

## 修正 3: ホストがビルドされる前に登録する

`builder.Build()` がカットオフ ラインです。その時点以降に `builder.Services` に追加したものは、実行中のホストに対しては静かに破棄されます。

```csharp
// .NET 11 preview 4
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

// Too late. The container was snapshotted in builder.Build().
builder.Services.AddScoped<IUserRepository, UserRepository>();

app.MapControllers();
app.Run();
```

すべての登録が `Build` の前に走るように並べ替えてください。このパターンが最もよく噛み付くのは、リファクタリングが `Add*` 呼び出しをメソッドに移動し、そのメソッドが間違った場所から呼ばれる場合です。便利なパターンは、すべての `services.Add*` 呼び出しを `IServiceCollection` の拡張メソッド内に置き、`Program.cs` の先頭付近の 1 箇所から呼び出すことです。

```csharp
// .NET 11 preview 4
public static class DependencyInjectionExtensions
{
    public static IServiceCollection AddDataServices(this IServiceCollection services)
    {
        services.AddScoped<IUserRepository, UserRepository>();
        services.AddScoped<IOrderRepository, OrderRepository>();
        return services;
    }
}

// Program.cs
builder.Services.AddDataServices();
var app = builder.Build();
```

`WebApplicationFactory<TEntryPoint>` に対する統合テストでは、同等のルールは `ConfigureTestServices` がテスト ホストがビルドされる前に走る、ということです。`factory.CreateClient()` の後にテスト メソッド本体内からコンテナーを変更すると、破棄されたコレクションを変更していることになります。

## 同じエラーに見えるバリエーション

いくつかの似たエラーは別の方法で解決され、同じバグとして扱うと時間を浪費します。

- **`Cannot consume scoped service '<X>' from singleton '<Y>'`**。登録は存在しますが、ライフタイムが間違っています。修正は `Y` を scoped にするか、`Y` で `IServiceScopeFactory` / `IServiceProvider` を取り、必要に応じてスコープを作成することです。[singleton から scoped へのキャプチャ問題](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/)で扱っています。
- **`No service for type 'IOptions<MyOptions>' has been registered`**。同じ根本原因、別のメッセージ: `services.Configure<MyOptions>(...)` または `services.AddOptions<MyOptions>().Bind(...)` をスキップしました。`Configure` を追加すると `IOptions<MyOptions>` が無料で登録されます。
- **`Implementation type 'X' can't be converted to service type 'Y'`**。`services.AddScoped(typeof(IFoo), typeof(Bar))` と書き、`Bar` が `IFoo` を実装していません。両方の引数が `Type` であるため、コンパイラーはこれをキャッチできません。型を修正するか、ジェネリック オーバーロードを使用してください。
- **`A suitable constructor for type 'X' could not be located`**。型は登録されていますが、DI が構築できません: 各パブリック コンストラクター パラメーターが解決可能でなければならず、コンストラクターはちょうど 1 つ(または選ばれたものに `[ActivatorUtilitiesConstructor]`)でなければなりません。これは `Unable to resolve service` エラーではありません。
- **Keyed サービス**: .NET 8 以降では、`AddKeyedScoped<IFoo, Foo>("primary")` は消費者側で `[FromKeyedServices("primary")] IFoo foo` を必要とします。プレーンな `IFoo` を要求すると、keyed 登録が存在してもサービス解決例外がスローされます。2 つのネームスペースは別物です。

## 登録が正しく接続されていることを確認する方法

3 つの素早いチェックは、どれだけの推測にも勝ります。

1. **開発コンソールから `IServiceProvider.GetService<T>()`**。`app.Build()` の直後、`app.Run()` の前に 1 行落とします。

   ```csharp
   // .NET 11 preview 4 - remove before commit
   using (var scope = app.Services.CreateScope())
   {
       var repo = scope.ServiceProvider.GetService<IUserRepository>();
       Console.WriteLine(repo is null ? "NOT REGISTERED" : repo.GetType().FullName);
   }
   ```

   `GetService<T>()` が `null` を返した場合、登録が不足しているか、別のコンテナーにスコープされています。`GetRequiredService<T>()` は、あなたがデバッグしているのと同じ `InvalidOperationException` をスローします。

2. **起動時にスコープを検証する**。`ValidateScopes = true` と `ValidateOnBuild = true` をサービス プロバイダー ファクトリーに渡すと、登録が壊れていればホストは起動を拒否します。

   ```csharp
   // .NET 11 preview 4
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

   `ValidateOnBuild` はビルド時に各登録を 1 回走査し、コンストラクター パラメーターが満たせない場合は早期に失敗します。開発環境では ASP.NET Core がこれを有効にしているため、エンドポイントに到達した瞬間ではなくアプリを開始した瞬間に例外が現れることがよくあります。

3. **登録を出力する**。登録が正しく見えるのに例外が発生し続ける場合、`Build` の前にコレクション自体をダンプします。

   ```csharp
   // .NET 11 preview 4
   foreach (var sd in builder.Services.Where(s => s.ServiceType.Name.Contains("UserRepository")))
   {
       Console.WriteLine($"{sd.Lifetime}: {sd.ServiceType.FullName} -> {sd.ImplementationType?.FullName ?? "factory"}");
   }
   ```

   これにより、`MyApp.OldNamespace.IUserRepository` を登録し、コントローラーが `MyApp.NewNamespace.IUserRepository` をインポートしているケースを捕捉できます。例外メッセージは完全なネームスペースを表示しますが、目はその上を滑ります。

## 経験豊富な開発者を捕まえるエッジ ケース

検査では正しく見えるコードでこの例外を引き起こすパターンがいくつかあります。

- **`Configure<TOptions>` コールバックに注入された `IConfiguration`**。コールバックは遅延実行されます。コールバック内で後に削除されるサービスを参照すると、起動時ではなくオプションが最初に解決されたときに例外が発生します。
- **コンストラクターで scoped 依存関係を解決するバックグラウンド サービス**。`BackgroundService` は singleton です。後者が scoped であれば、そのコンストラクターは `IUserRepository` を要求できません。`IServiceScopeFactory` を注入し、`ExecuteAsync` 内でスコープを作成し、スコープから解決してください。
- **ジェネリック ホストされたサービス**。`services.AddHostedService<MyHostedService<MyArg>>()` は、閉じたジェネリック `MyHostedService<MyArg>` が DI で構築可能であることを必要とします。つまり `MyArg` も解決可能でなければなりません。オープン ジェネリックには `services.AddTransient(typeof(IRepo<>), typeof(Repo<>))` が必要です。
- **ソース生成された DI コンテナー**。Strawberry Shake、Refit、gRPC のソース ジェネレーターは、`IServiceCollection` で独自のクライアントを登録することがあります。`Build` の後にそれらの `Add*` 拡張を呼ぶと、同じ静かな破棄ルールが適用されます。
- **Native AOT ビルド**。.NET 11 のトリミングフレンドリーなデフォルト コンテナーは、デフォルトでもまだリフレクションで解決します。`<PublishTrimmed>true</PublishTrimmed>` で公開し、トリマーが実装型を削除すると、ソースは問題なくコンパイルされても、ランタイムでサービス解決例外が表示されます。修正は `[DynamicDependency]` か、型付きファクトリー経由で型を登録することです。

## 関連

- ログと DI をきれいに一緒に配線する: [.NET 11 での Serilog と Seq による構造化ログ出力](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)。
- ライフタイムを間違えるとこの後にぶつかる次の例外: [scoped DbContext を消費する singleton](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/)。
- DI が同じ `DbContext` を 2 つのリクエストに渡したときに表面化する関連の EF Core 誤用: [a second operation was started on this context instance](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/)。
- fake を登録してこの例外を回避するテスト時の DI スワップ: [EF Core 11 テストでのプール DbContext ファクトリー](/ja/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)。
- 関連する `IConfiguration` の失敗モード: [no connection string named 'DefaultConnection' could be found](/ja/2026/05/fix-no-connection-string-named-defaultconnection/)。

## ソース

- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection)。
- Microsoft Learn, [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines)。
- Microsoft Learn, [Keyed services in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services)。
- Microsoft Learn, [Use scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-usage#scope-validation)。
- ASP.NET Core ソース、例外がスローされる [`ActivatorUtilities.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection.Abstractions/src/ActivatorUtilities.cs)。
