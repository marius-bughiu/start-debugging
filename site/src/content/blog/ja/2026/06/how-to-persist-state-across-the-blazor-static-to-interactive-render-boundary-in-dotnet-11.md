---
title: ".NET 11 で Blazor の静的から対話的へのレンダリング境界をまたいで状態を保持する方法"
description: "プリレンダリングされた Blazor コンポーネントは初期化を 2 回実行し、対話的への引き継ぎで状態を失います。.NET 11 の [PersistentState] 属性または PersistentComponentState サービスで解決します。"
pubDate: 2026-06-09
template: how-to
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "ssr"
lang: "ja"
translationOf: "2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-09
---

Blazor Web App テンプレート上の Blazor コンポーネントは、初期化を 2 回実行します。1 回はプリレンダリング中（静的なサーバー側レンダリング）で、もう 1 回はコンポーネントが対話的にレンダリングされるときです。最初に `OnInitializedAsync` で取得または計算したものは 2 回目までに失われるため、コンポーネントは再取得し、ユーザーはプリレンダリングされた UI が置き換えられる際にちらつくのを目にします。解決策は、その状態をプリレンダリング中にキャプチャし、境界をまたいで引き渡すことです。.NET 11 では、これを行う方法が 2 つあります。宣言的な `[PersistentState]` 属性（簡単な方法で、.NET 10 以降で利用可能）と、命令的な `PersistentComponentState` サービス（.NET 8 以降で利用可能で、属性で表現できないものすべてに対応）です。この記事は .NET 11（執筆時点ではプレビュー、GA は 2026 年 11 月予定）と `Microsoft.AspNetCore.Components` 11.0.x パッケージセットを対象としています。

## なぜコンポーネントは 2 回初期化されるのか

Blazor Web App テンプレートは、ページを 2 つのパスでレンダリングします。最初のパスはプリレンダリングです。サーバーがコンポーネントを静的な HTML として実行し、`OnInitialized` / `OnInitializedAsync` を実行し、結果のマークアップを送信して、ページが素早く描画され、適切にインデックスされるようにします。2 番目のパスは対話性です。ランタイムが起動すると（`InteractiveServer` の場合は SignalR サーキット、`InteractiveWebAssembly` の場合はダウンロードされた WASM ペイロード、`InteractiveAuto` の場合はそのいずれか）、Blazor はコンポーネントの新しいコピーをインスタンス化し、初期化を 2 回目に実行します。

この 2 番目のインスタンスは、プリレンダリング中に設定したフィールドを一切継承しません。デフォルト値から開始します。初期化が次のようになっていた場合:

```razor
@* PrerenderedCounter1.razor *@
@* .NET 11, Blazor Web App, any interactive render mode *@
@page "/prerendered-counter-1"
@inject ILogger<PrerenderedCounter1> Logger

<p role="status">Current count: @currentCount</p>

@code {
    private int currentCount;

    protected override void OnInitialized()
    {
        currentCount = Random.Shared.Next(100);
        Logger.LogInformation("currentCount set to {Count}", currentCount);
    }
}
```

プリレンダリング中に `currentCount set to 41`、そしてコンポーネントが対話的になる少し後に `currentCount set to 92` が表示され、ブラウザーでは 41 から 92 への目に見える切り替わりが起こります。乱数の場合、これは単なる珍しい現象です。データベース呼び出しの場合は、重複したクエリ、遅い対話可能までの時間、そしてプリレンダリングされた値と再取得された値の間の実際のちらつきになります。

これは具体的にはプリレンダリングから対話的への境界です。`Routes` コンポーネントが render mode を定義しておらず、内部の[拡張ナビゲーション](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing)を経由してページに到達した場合、プリレンダリングはまったく発生しないため、初期化は 1 回実行され、保持するものは何もありません。二重初期化を再現するには、ページの完全な再読み込みが必要です。

## 宣言的な解決策: `[PersistentState]` 属性

.NET 11 で状態を境界をまたいで運ぶ最もきれいな方法は、それをパブリックプロパティに置き、`[PersistentState]` で注釈を付けることです。Blazor はそのプロパティをプリレンダリングされた HTML にシリアライズし、その後、初期化の前に対話的なインスタンスへデシリアライズして戻します。あなたの仕事は、値が復元されたかどうかを検出することだけです:

```razor
@* PrerenderedCounter2.razor *@
@* .NET 11 / .NET 10. [PersistentState] requires aspnetcore 10.0+ *@
@page "/prerendered-counter-2"
@inject ILogger<PrerenderedCounter2> Logger

<p role="status">Current count: @CurrentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int? CurrentCount { get; set; }

    protected override void OnInitialized()
    {
        if (CurrentCount is null)
        {
            CurrentCount = Random.Shared.Next(100);
            Logger.LogInformation("CurrentCount set to {Count}", CurrentCount);
        }
        else
        {
            Logger.LogInformation("CurrentCount restored to {Count}", CurrentCount);
        }
    }

    private void IncrementCount() => CurrentCount++;
}
```

これでログは、プリレンダリング中に `CurrentCount set to 96`、対話性が始まると `CurrentCount restored to 96` を示します。同じ値で、2 回目の `Random.Shared.Next` はなく、ちらつきもありません。

3 つのルールがこれを機能させますが、つまずきやすいものです:

1. **プロパティは `public` でなければなりません。** フレームワークは、シリアライズ、trimming 解析、ソースジェネレーションのタスクにこれに対するリフレクションを使用します。属性を付けた `private` フィールドは取得されません。
2. **null 許容、またはデフォルト値を検出できる型を使用します。** 「復元された」と「設定されたことがない」を区別する必要があります。null 許容型（`int?`、`WeatherForecast[]?`）が慣用的なシグナルです。参照型の場合、`null` はプリレンダリングがそれを設定する必要があることを意味します。
3. **null のときだけ設定します。** `if (CurrentCount is null)` のガードが、コストの高い処理をプリレンダリングパスに留め、対話的なパスではそれをスキップします。

現実的なバージョンはデータの読み込みです。プリレンダリングで取得し、対話的では再利用します:

```razor
@* ContactList.razor -- .NET 11, InteractiveAuto render mode *@
@page "/contacts"
@inject IContactService Contacts

@if (Items is null)
{
    <p>Loading...</p>
}
else
{
    <ul>@foreach (var c in Items) { <li>@c.Name</li> }</ul>
}

@code {
    [PersistentState]
    public IReadOnlyList<Contact>? Items { get; set; }

    protected override async Task OnInitializedAsync()
    {
        // Runs the query on the prerender pass; the interactive pass
        // gets Items back already populated and skips the call.
        Items ??= await Contacts.GetAllAsync();
    }
}
```

### 状態を正しいインスタンスに紐づける

ページがループ内で同じ型の複数のコンポーネントをレンダリングする場合、保持された状態は正しいインスタンスに突き合わせて戻す必要があります。`@key` ディレクティブを使用して、Blazor がシリアライズされた blob を適切なコンポーネントに対応付けられるようにします:

```razor
@* Parent.razor -- .NET 11 *@
@page "/parent"

@foreach (var element in elements)
{
    <PersistentChild @key="element.Name" />
}
```

`PersistentChild` の内部では、`[PersistentState]` プロパティはキーごとに復元されます。`@key` がないと、2 つのインスタンスが状態を入れ替えたり失ったりする可能性があります。

### 読み取り専用データと拡張ナビゲーション

デフォルトでは、保持された状態は対話的なコンポーネントがページに最初に読み込まれたときにのみ読み込まれます。これは意図的なものです。同じページへのその後の拡張ナビゲーションが、編集途中のフォームのようなライブの状態を上書きするのを防ぎます。状態が読み取り専用で、一瞬間違っていても問題が小さい場合（取得にコストがかかるがめったに変わらないキャッシュデータ）は、`AllowUpdates` を使って拡張ナビゲーション中の更新をオプトインします:

```csharp
// .NET 11 -- allow the value to refresh on enhanced navigation
[PersistentState(AllowUpdates = true)]
public WeatherForecast[]? Forecasts { get; set; }

protected override async Task OnInitializedAsync()
{
    Forecasts ??= await ForecastService.GetForecastAsync();
}
```

拡張ナビゲーションをまたぐ保持は .NET 10 以降の機能であることに注意してください。.NET 8 と .NET 9 では、`PersistentComponentState` サービスは最初のページ読み込み時にのみ状態を提供し、すでに実行中のサーキット上での拡張ナビゲーションをまたいで提供することは決してありませんでした。その動作に依存している場合、.NET 11 がそれがきれいに機能する場所です。

### 特定の状況で復元をスキップする

.NET 10 は `[PersistentState]` に 2 つ目の仕事を追加しました。`InteractiveServer` サーキットが破棄されたときに状態を保持し、再接続時に復元することで、接続が切れてもコンポーネントの状態が消えないようにします。これにより、復元を見送りたい 2 つのケースが生まれます。`RestoreBehavior` がそれらを制御します:

```csharp
// Do not restore the prerendered value (start fresh on interactivity)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipInitialValue)]
public string? NoPrerenderedData { get; set; }

// Do not restore the last snapshot on reconnection (force fresh data after a reconnect)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipLastSnapshot)]
public int CounterNotRestoredOnReconnect { get; set; }
```

## 命令的な解決策: `PersistentComponentState` サービス

属性はほとんどのケースをカバーしますが、単一のプロパティではないものを保持する必要がある場合もあります。複数のフィールドから導出した値、実行時に計算するキー、特定の条件下でのみ保持する状態などです。`PersistentComponentState` サービスを注入し、コールバックを登録します。これは元々の .NET 8 のメカニズムで、.NET 11 でも以前とまったく同じように機能します:

```razor
@* PrerenderedCounter3.razor -- .NET 11, PersistentComponentState service *@
@page "/prerendered-counter-3"
@implements IDisposable
@inject ILogger<PrerenderedCounter3> Logger
@inject PersistentComponentState ApplicationState

<p role="status">Current count: @currentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    private int currentCount;
    private PersistingComponentStateSubscription persistingSubscription;

    protected override void OnInitialized()
    {
        if (!ApplicationState.TryTakeFromJson<int>(
            nameof(currentCount), out var restoredCount))
        {
            currentCount = Random.Shared.Next(100);
            Logger.LogInformation("currentCount set to {Count}", currentCount);
        }
        else
        {
            currentCount = restoredCount!;
            Logger.LogInformation("currentCount restored to {Count}", currentCount);
        }

        // Register LAST to avoid a race condition at app shutdown.
        persistingSubscription = ApplicationState.RegisterOnPersisting(PersistCount);
    }

    private Task PersistCount()
    {
        ApplicationState.PersistAsJson(nameof(currentCount), currentCount);
        return Task.CompletedTask;
    }

    private void IncrementCount() => currentCount++;

    void IDisposable.Dispose() => persistingSubscription.Dispose();
}
```

形は常に同じです:

1. 最初に `TryTakeFromJson<T>("key", out var value)`。`true` を返したら、対話的なパスにいて、値は復元されています。`false` なら、プリレンダリングパスにいて、値を生成する必要があります。
2. `RegisterOnPersisting` で保持コールバックを登録し、その中で `PersistAsJson("key", value)` を呼び出します。アプリのシャットダウン時の競合状態を避けるため、初期化の**最後**に登録します。
3. コールバックがリークしないように `PersistingComponentStateSubscription` を破棄します。ここでは `IDisposable` の実装は任意ではありません。

`RegisterOnPersisting` が保持を制御するのと同じように復元を命令的に制御する必要がある場合、.NET 10 は `RegisterOnRestoring` を追加しました。これにより復元ステップにフックできます。これは上記のサーキット再接続のシナリオと自然に組み合わさります。

## コンポーネントではなくサービスに存在する状態を保持する

状態は常にコンポーネントに属しているわけではありません。scoped な DI サービスがデータを保持している場合、そのプロパティも保持できます。プロパティを `[PersistentState]` でマークし、`RegisterPersistentService` でサービスを保持用に登録して、どの render mode に適用するかを Blazor に伝えます（render mode はサービスの型からは推論できません）:

```csharp
// CounterTracker.cs -- .NET 11
public class CounterTracker
{
    [PersistentState]
    public int CurrentCount { get; set; }

    public void IncrementCount() => CurrentCount++;
}
```

```csharp
// Program.cs -- .NET 11
using Microsoft.AspNetCore.Components.Web;

builder.Services.AddScoped<CounterTracker>();

builder.Services.AddRazorComponents()
    .RegisterPersistentService<CounterTracker>(RenderMode.InteractiveAuto);
```

サポートされるのは scoped なサービスのみです。render mode 引数（`RenderMode.Server`、`RenderMode.Webassembly`、または `RenderMode.InteractiveAuto`）が、どの対話的コンテキストがデシリアライズされた状態を受け取るかを決定します。シリアライズは実際のインスタンスに基づいて動作するため、抽象を保持サービスとしてマークし、具体的な実装を internal に保つことができます。これは、プリレンダリングサーバーと WebAssembly クライアントがインターフェースは共有するが実装は共有しない場合に便利です。

## 何が回線を通るか、そして越えてはならないセキュリティの一線

保持された状態は HTML に埋め込まれ、クライアントに転送されます。それがどこに着地するかは render mode によって決まり、これが利便性を漏洩に変える唯一の間違いです:

- **`InteractiveServer`**: 状態はブラウザーを経由して往復しますが、[ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/introduction) によって保護されているため、転送中は暗号化されています。
- **`InteractiveWebAssembly` と `InteractiveAuto`**: WebAssembly のコードはクライアントで実行され、それを読み取る必要があるため、状態は平文でブラウザーに公開されます。`Auto` モードは WebAssembly に解決される可能性があるため、CSR のケースと同様に扱ってください。

ルール: WebAssembly または Auto のコンポーネントの保持された状態には、プライベートなものを決して置かないでください。連絡先リストは保持しますが、アクセストークンは保持しません。サーバーのみのシークレットが必要な場合は、それらをサーバー側に保持し、対話性の後に取得するか、`InteractiveServer` に留まってください。

## シリアライズ、trimming、Native AOT

デフォルトでは、`[PersistentState]` と `PersistAsJson` は既定の設定で `System.Text.Json` を使ってシリアライズします。これには計画しておくべき 2 つの帰結があります。

第一に、デフォルトのシリアライザーは trimmer セーフではありません。IL trimming または [Native AOT](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) で発行する場合、保持する型を保存しなければ、メタデータが trimming で除去された時点でラウンドトリップが実行時に失敗します。保持する型に対して `JsonSerializerContext` ソースジェネレーターを設定してください。これは [System.Text.Json 用のカスタム JsonConverter を書く](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)際に適用するのと同じ規律です。

第二に、デフォルトの JSON 形状が合わない場合（コンパクトなバイナリ形式、レガシーなエンコーディング、System.Text.Json が扱いにくい型）、.NET 10 は `PersistentComponentStateSerializer<T>` を導入したので、特定の型のシリアライズを引き継ぐことができます:

```csharp
// Registered in Program.cs; applies to int? persisted state
builder.Services.AddSingleton<PersistentComponentStateSerializer<int?>,
    CustomIntSerializer>();
```

シリアライザーは `Persist(T value, IBufferWriter<byte> writer)` と `Restore(ReadOnlySequence<byte> data)` を実装します。型に対して登録されたカスタムシリアライザーがなければ、Blazor は JSON にフォールバックするため、これを実装するのは必要な型に対してだけです。

## Razor Pages または MVC に埋め込まれたコンポーネント

Blazor Web App テンプレートには当てはまりませんが、既存のアプリに Blazor を埋め込む際に人々を捕まえる細部があります。対話的なコンポーネントを Razor Pages や MVC のビューに配置する場合、保持メカニズムには手動で追加した tag helper が必要です。レイアウトの閉じる `</body>` の直前に `<persist-component-state />` を置きます:

```cshtml
@* Pages/Shared/_Layout.cshtml -- only needed for Razor Pages / MVC hosts *@
<body>
    ...
    <persist-component-state />
</body>
```

純粋な Blazor Web App プロジェクトはこれを自動的に配線します。tag helper が必要なのは混在ホスティングの場合だけです。

## 2 つのモデルのどちらを選ぶか

まず `[PersistentState]` に手を伸ばしてください。コードが少なく、プリレンダリング境界とサーキット再接続を無料で処理し、`AllowUpdates` と `RestoreBehavior` が一般的なバリエーションを宣言的にカバーします。状態の単位が単一のパブリックプロパティでない場合、保持キーを実行時に計算する場合、またはコールバック内で条件付きで保持する必要がある場合は、`PersistentComponentState` サービスに切り替えてください。両者は同じアプリ内で共存でき、どちらも同じ根本的な問題を解決します。プリレンダリング中に行った作業が、すべてやり直されるのではなく、対話性へのジャンプを生き延びるようにすることです。

ページがどの render mode を使うべきかをまだ決めている段階なら、[.NET 11 における Blazor Server vs Blazor WebAssembly vs Blazor United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) のトレードオフが、そもそもプリレンダリングが適用される場所を整理します。古いアプリをこのモデルへ移行している場合は、[Blazor Server から Blazor Web App への移行チェックリスト](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)が、プリレンダリングの二重実行を唯一の落とし穴として挙げています。レンダリング状態を保持するのではなく一度きりのメッセージを渡すには、代わりに [.NET 11 の Blazor SSR の TempData サポート](/ja/2026/04/blazor-ssr-tempdata-dotnet-11/)が適切なツールです。

一次情報: Microsoft Learn の [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0)。`[PersistentState]` 属性、`PersistentComponentState` サービス、`RegisterPersistentService`、および .NET 10 と .NET 11 向けの `PersistentComponentStateSerializer<T>` 拡張ポイントが文書化されています。
