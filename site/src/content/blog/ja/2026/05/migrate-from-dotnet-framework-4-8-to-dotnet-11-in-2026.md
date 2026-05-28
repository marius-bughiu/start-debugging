---
title: "2026 年に .NET Framework 4.8 から .NET 11 へ移行する"
description: "2026 年に .NET Framework 4.8 のコードベースを .NET 11 LTS へ移行するための、バージョンを固定した移行プレイブック。SDK スタイル csproj への書き換え、System.Web から ASP.NET Core への移行、WCF、EF6 から EF Core 11、BinaryFormatter の削除、AppDomain の代替、現実的なロールバック計画までを扱います。"
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
lang: "ja"
translationOf: "2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026"
translatedBy: "claude"
translationDate: 2026-05-28
---

.NET Framework 4.8 のコードベースを .NET 11 へ移行する作業は、単なるバージョンアップではありません。プロジェクト形式、Web スタック、データアクセス層、ホスティングモデル、そして 2017 年から 2026 年の間に静かに姿を消した数多くの API に手を入れる、再プラットフォーム化の取り組みです。.NET Framework 4.8 の公式サポート期間は 2026 年時点でまだ継続中ですが、ランタイムは 2019 年以降に機能更新を受けておらず、最近の Azure App Service プランはデフォルトで Core スタックに移行しており、依存する価値のある NuGet パッケージのほとんどはすでに `net48` のターゲットを取り下げています。典型的な業務アプリで現実的に必要な工数は、小規模なサービスなら 2 週間から 6 週間、WCF、EF6、および WebForms か MVC 5 のフロントエンドを抱える中規模のコードベースなら 2 か月から 4 か月です。WebForms アプリは現状のままにするか、書き直すかのいずれかであり、その場での移行パスは存在しません。本記事ではソースを `net48`、ターゲットを `net11.0` に固定し、プロジェクトが Windows 上で動作していることを前提とします。

## なぜ今移行するのか

- .NET Framework 4.8 は 2022 年 8 月の 4.8.1 リリース以降、メンテナンスモードのみとなっています。新しい API も新しい C# 言語機能もありません。.NET 11 ランタイムは動的 PGO がデフォルトで有効になり、近代化された段階的 JIT、ASP.NET Core minimal API 向けの Native AOT が同梱されています。
- Microsoft の新しいフレームワーク (Aspire、Microsoft Agent Framework、Semantic Kernel 1.x、Azure Functions 分離ワーカー) はいずれも `net8.0` 以降をターゲットとしており、バックポートされません。4.8 にとどまるということは、これらのいずれも自身のプロセスから利用できないことを意味します。
- クラウドコスト。.NET 11 でアイドル状態の ASP.NET Core minimal API のランタイムメモリフットプリントは、同等の負荷における ASP.NET 4.8 ワーカープロセスの約 35 から 50 パーセントであり、これはそのまま App Service プランの縮小、あるいは Kubernetes でのポッド密度の向上に直結します。
- 採用とツール。Roslyn のアナライザー、ソースジェネレーター、そして最新の `dotnet` CLI は SDK スタイルプロジェクトを前提としています。`net48` での C# 言語バージョンは、コンパイラと戦わない限り C# 7.3 に制限されており、10 年分の言語機能が使えないままになります。

コードベースが Windows でしか動作せず、他の場所へデプロイする計画もない Windows デスクトップアプリ (WinForms または WPF) であれば、移行すべきかという問いは妥当です。それでも答えはたいてい「はい」です。net48 のサポート期間は Windows 10 の延長サポート期間で終了し、ツールのサポートはすでに薄くなっているためです。

## 何が壊れるのか

| 領域                          | 変更内容                                                                                              | 深刻度     |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| プロジェクト形式              | `packages.config` および古い csproj XML は .NET 11 SDK でサポートされません                          | 高         |
| `System.Web`                  | 完全に削除されました。`HttpContext.Current`、モジュール、ハンドラー、WebForms に .NET 11 の代替はありません | 高         |
| WCF サーバー                  | サーバー側の `System.ServiceModel` はサポートされません。CoreWCF を使うか、gRPC または HTTP に書き直してください | 高         |
| WCF クライアント              | `System.ServiceModel.*` 6.x の NuGet パッケージ経由でサポートされますが、バインディングは限定されます | 中         |
| Entity Framework 6            | EF6 6.5.0 以降であれば .NET 11 上で動作しますが、新規開発では EF Core 11 を使うべきです              | 中         |
| `AppDomain`                   | デフォルトの `AppDomain` のみ存在します。`CreateDomain` もアンロード可能なプラグインコンテナーもありません | 高         |
| `BinaryFormatter`             | .NET 9 で削除されました。オプトインスイッチもありません                                              | 高         |
| .NET Remoting                 | 廃止されました。代替はなく、本当に使いたいネットワークプロトコルへ書き直すしかありません             | 高         |
| Code Access Security          | 廃止されました。`[SecurityCritical]`、`PermissionSet`、サンドボックスもすべて削除されました          | 高         |
| `web.config`                  | 構成は `appsettings.json` へ移ります。`system.web` セクションは適用されません                        | 高         |
| `app.config`                  | ほとんどの設定は `Microsoft.Extensions.Configuration.Xml` 経由で動作しますが、バインディングリダイレクトはなくなりました | 中         |
| WPF と WinForms               | .NET 11 でサポートされますが、Windows のみです。ほとんどのサードパーティ製コントロールは 6.x 以降のビルドが必要です | 中         |
| `System.Drawing.Common`       | クロスプラットフォームのサポートは .NET 6 で削除され、それ以降は Windows 専用です                    | 中         |

`.csproj` に触れる前に、[.NET Framework から .NET への移植の概要](https://learn.microsoft.com/en-us/dotnet/core/porting/) と [.NET 11 の破壊的変更一覧](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0) を一度読んでおいてください。前者ははるかに長い方のリストです。

## 事前チェックリスト

プロジェクトファイルを 1 行でも変更する前に、以下を実行してください。

1. すべての開発マシンと CI ランナーに .NET 11 SDK をインストールします。`dotnet --list-sdks` で確認し、`11.0.x` が表示されることを確かめてください。古いソリューションが Visual Studio で引き続き開けるよう、.NET Framework 4.8 開発者パックはインストールしたままにしておきます。
2. .NET Upgrade Assistant CLI をインストールし、まずは分析モードで実行します。このツールはコードを移行するわけではなく、実行可能なレポートを生成します。
   ```bash
   # .NET 11, upgrade-assistant 0.6.x
   dotnet tool install --global upgrade-assistant
   upgrade-assistant analyze MySolution.sln
   ```
3. .NET Portability Analyzer または `apiport` をコンパイル済みアセンブリに対して実行します。"not portable" と表示されたものは、upgrade-assistant ツールが代行してくれない移行作業です。
4. ベースラインを取得します。既存のテストスイートを .NET Framework 4.8 上で実行し、その結果を保存しておきます。古いランタイムでグリーンであれば、.NET 11 で最初に赤になったものは明確に移行回帰だと判断できます。
5. サードパーティの NuGet パッケージを棚卸しします。`net48` または `net472` のアセンブリしか提供していないものはブロッカーです。代替候補としては `log4net` 2.0.16、`Newtonsoft.Json` 13.x、`AutoMapper` 13.x、`Dapper` 2.1.x がいずれもマルチターゲットで .NET 11 で動作します。それ以外はベンダーへのアップグレードチケットが必要です。
6. 移行をブランチで行います。プロジェクトごとに少なくとも 1 つの PR、テストプロジェクト用には別の PR を用意してください。中規模コードベースに対する 1 本の超巨大 PR はレビュー不能です。

## 移行手順

1. **すべての `.csproj` を SDK スタイルへ変換する。** 古い XML を SDK スタイルのヘッダーへ置き換えます。新形式はファイルを推測で取り込み、アセンブリ参照のほとんどを省き、`packages.config` の代わりに `PackageReference` を使います。機械的な部分は `try-convert` ツール (.NET Upgrade Assistant に同梱) が処理してくれます。

   ```xml
   <!-- src/MyApi.csproj, .NET 11, after conversion -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
       <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     </ItemGroup>
   </Project>
   ```

   検証方法: `dotnet build` が、プロジェクトファイル自体のパーサーエラーではなく、削除された API を名指しするエラーで終了することを確認します。変換が成功したら `packages.config` を削除します。

2. **`BinaryFormatter` の使用箇所をすべて削除する。** この型は互換スイッチなしで .NET 9 で削除されました。JSON 形式かバイナリ形式かに応じて `System.Text.Json`、MessagePack、または `protobuf-net` で置き換えます。`BinaryFormatter` でシリアライズした blob を保存している場合は、旧環境を廃止する前に、.NET Framework 4.8 上で動作するワンショット変換ユーティリティを書き、新しい形式へ変換しておきます。この変換を .NET 11 から行うことはできません。

   検証方法: `grep -r "BinaryFormatter" src/` が空であること。バイナリ形式のペイロードを保持していた blob ストレージはすべて再シリアライズされており、新しい形式がユニットテストでラウンドトリップすることを確認します。

3. **Web スタックを `System.Web` から ASP.NET Core 11 へ書き換える。** これが最大の単一作業です。MVC 5 のコントローラーはほぼ 1 対 1 で ASP.NET Core のコントローラーに対応しますが、ルーティング属性、モデルバインディング、アクションフィルター、依存性注入はすべて異なります。`HttpContext.Current` はなくなり、コントローラーやミドルウェアは明示的に `HttpContext` を受け取ります。`Global.asax` の `Application_Start` は `Program.cs` のスタートアップコードに変わります。WebAPI 2 のコントローラーは ASP.NET Core のコントローラーに非常に近いですが、`ApiController` ではなく `ControllerBase` を継承する形になります。

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddControllers();
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.UseAuthentication();
   app.UseAuthorization();
   app.MapControllers();
   app.MapOpenApi();
   app.Run();
   ```

   WebForms (`.aspx`) には移行パスがありません。WebForms アプリは残りの寿命を通じて .NET Framework 4.8 のままリバースプロキシの背後で稼働させ続けるか、影響を受けるページを Blazor、MVC、または Razor Pages として書き直すかのいずれかです。Blazor を選択肢に入れるのであれば、[Blazor Server vs Blazor WebAssembly vs Blazor United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) の比較が出発点として適切です。

   検証方法: 各コントローラーには、`WebApplicationFactory<Program>` に対して HTTP ルートを実行し、ステータスコードとレスポンスボディの両方をアサートする統合テストが少なくとも 1 つあることを確認します。

4. **`web.config` を `appsettings.json` へ移す。** 接続文字列、カスタム appSettings、ロギング構成は JSON に移ります。`system.web` セクションは適用されません。`system.webServer` セクションのうち IIS を構成するものは、インプロセスモジュール経由で IIS の背後にホストする場合は引き続き適用されますが、現在の本番デプロイのほとんどは Kestrel を直接使っています。認証設定は `<authentication>` および `<authorization>` の web.config セクションから、`builder.Services.AddAuthentication(...)` と認可ポリシー API へ移ります。

   ```json
   // appsettings.json, .NET 11
   {
     "ConnectionStrings": {
       "Default": "Server=.;Database=App;Trusted_Connection=True;TrustServerCertificate=True;"
     },
     "Logging": {
       "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" }
     }
   }
   ```

   検証方法: アプリが以前は構成で駆動されていたすべての値を `IConfiguration` か、強く型付けされた `IOptions<T>` パターンを通じて読み込むこと。本番コードに `ConfigurationManager.AppSettings` の呼び出しが残っていないことを確認します。

5. **WCF を処理する。** サーバー側の WCF は .NET 11 でサポートされません。現実的な選択肢は 2 つです。
   - **CoreWCF** (コミュニティが保守する移植版)。`CoreWCF.Primitives`、`CoreWCF.Http`、および実際に使用しているバインディングを追加します。ほとんどの `BasicHttpBinding` と `NetTcpBinding` のサービスは、コントラクトの参照と `UseServiceModel` 設定の呼び出しで移行できます。ストリーミング、トランザクション、メッセージレベルセキュリティはサポート度合いがまちまちなので、コミットする前に [CoreWCF 互換性マトリクス](https://github.com/CoreWCF/CoreWCF) を確認してください。
   - **gRPC または HTTP API へ書き直す。** 上限は高くなりますが、作業量も増えます。WCF インターフェースを利用するのが自分たちの管理下にあるクライアントのみだった場合は、これが適切な選択です。

   クライアント側の WCF は、`System.ServiceModel.*` 6.x の NuGet パッケージを通じて、`BasicHttpBinding`、`NetTcpBinding` (限定)、`WSHttpBinding` (トランスポートセキュリティのみ) でサポートされます。クライアントが `WSFederationHttpBinding` やメッセージレベルセキュリティを使っている場合は、コンシューマーを書き直すことになります。

   検証方法: 各 WCF エンドポイントには、新しい CoreWCF ホストか書き直した代替に対して .NET 11 クライアントを実行し、古い .NET Framework クライアントと同じペイロードをアサートするコントラクトテストがあることを確認します。

6. **(価値がある場合は) Entity Framework 6 を EF Core 11 へ移す。** EF6 は `EntityFramework` 6.5.0 パッケージを通じて .NET 11 上で動作するため、厳密な lift-and-shift も可能です。しかし EF6 には新機能の追加はなく、EF Core の `DbContext` API は ASP.NET Core の依存性注入と相性がよく、EF Core 11 のコンパイル済みクエリとプリミティブコレクションの変換は意味のある速度向上をもたらします。ほとんどのチームにとっての正解は、まずは EF6 のまま移行を出荷し、その後の PR で EF Core へ移行することです。[EF Core compiled queries vs raw SQL vs Dapper](/ja/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) の記事がホットパスでの速度向上を定量化しています。

   検証方法: 選んだ ORM が、生成された SQL をアサートするテストも含め、.NET Framework 上の EF6 で動いていたのと同じ統合テストスイートに合格すること。

7. **`AppDomain.CreateDomain` のプラグインローダーを置き換える。** .NET 11 では `AppDomain` はもはや分離境界ではなく、デフォルトドメインのみが存在します。アンロードのセマンティクスや障害分離のために以前は子 `AppDomain` にアセンブリをロードしていたプラグインシステムは、`isCollectible: true` を指定した `AssemblyLoadContext` に移行し、完了時に `Unload()` を呼び出す必要があります。プラグインが信頼できない場合は、`dotnet` ワーカープロセスを使ったアウトオブプロセスプラグインが安全なパターンです。

   検証方法: ユニットテストでプラグインアセンブリをロードしてその中を呼び出し、`AssemblyLoadContext` をアンロードし、`GC.Collect()` のサイクル後に当該コンテキストへの `WeakReference` が `null` になることをアサートします。

8. **C# 言語バージョンの引き上げを精査する。** C# 7.3 から C# 14 への移行は、一度に 12 個分の言語リリースを跨ぐことになります。そのほとんどは追加的で安全ですが、null 許容参照型 (C# 8 で導入) は `<Nullable>enable</Nullable>` をグローバルに有効にすると、レガシーコードで数千件の警告を出します。現実的な道筋は、まず `<Nullable>annotations</Nullable>` (アノテーションのみで診断なし) にしてから、`#nullable enable` プラグマでファイルごとに変換していくことです。C# 14 の Span オーバーロード周りのオーバーロード解決の変更は、修正記事の [C# 14 overload resolution breaking change with spans](/ja/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) に記載されています。

   検証方法: マージ前に、合意した null 許容スコープに対して `dotnet build -warnaserror` がクリーンに通ること。

9. **CI ランナーのイメージを更新する。** GitHub Actions の `actions/setup-dotnet` を `dotnet-version: 11.0.x` に引き上げ、Dockerfile のベースイメージを `mcr.microsoft.com/dotnet/sdk:11.0` および `mcr.microsoft.com/dotnet/aspnet:11.0` に更新し、古い .NET Framework MSBuild イメージを削除します。.NET Framework でのビルドが必要なプロジェクト (たとえばステップ 2 のワンショット `BinaryFormatter` 変換ツール) がまだ残っている場合は、.NET Framework 4.8 開発者パックをインストールした `windows-2022` ランナーを 1 つだけ残し、パスフィルターでゲートします。

   検証方法: フィーチャーブランチでパイプラインを実行し、`dotnet publish`、コンテナーイメージのビルド、ステージング環境へのスモークデプロイまで含めて、エンドツーエンドでグリーンになることを確認します。

## 検証 (スモークチェックリスト)

上記の手順を終えた後、移行 PR をマージする前にアプリは以下のすべての項目を通過している必要があります。

- `dotnet --list-sdks` が `11.0.x` を表示し、リポジトリのルートから `dotnet --version` を実行すると `11.0.x` が出力されること。
- `dotnet restore && dotnet build -c Release` が、合意した null 許容スコープに対して警告ゼロで終了コード 0 になること。
- `dotnet test -c Release` がグリーンで、テスト件数が .NET Framework 4.8 のベースラインと一致 (または上回る) こと。
- `dotnet publish -c Release` が、.NET Framework 4.8 の再配布可能パッケージがインストールされていないクリーンなステージングホスト上で起動する自己完結型の成果物を生成すること。
- すべての HTTP ルートに、`WebApplicationFactory<Program>` を使った統合テストが少なくとも 1 つあること。
- 本番のコードパスで、ログに `BinaryFormatter`、`IWebHostBuilder`、`HttpContext.Current`、または `ConfigurationManager` への first-chance 例外参照が現れないこと。
- ステージングデプロイでゴールデンパスが提供されており、同等のハードウェアにおける .NET Framework のベースラインに対して p50/p95 のレイテンシが 20 パーセント以内に収まっていること。

これらのいずれかが失敗したら止まってください。.NET 11 への中途半端な移行は、クリーンな .NET Framework 4.8 のデプロイより悪い結果になります。両方のランタイムに同時にコミットすることになるからです。

## ロールバック

データベーススキーマやワイヤ形式が変更されていない限り、移行は可逆的です。ランタイムの差し替え自体は可逆的で、`.csproj` の変更を戻し、ホストに .NET Framework 4.8 の再配布可能パッケージを再インストールすればよいだけです。ロールバックを高コストにする判断は、たいてい直交した部分にあります。

- 新しい EF Core 11 のマイグレーションが本番データベースに対して実行された場合。まずスキーマをロールバックする必要があります。
- `System.Text.Json` のデフォルトで JSON ペイロードを再シリアライズしており、`Newtonsoft.Json` とデフォルトが異なる場合。フィールドの並び順や null の扱いをパターンマッチしている下流のコンシューマーはドリフトを検知します。
- 認証が `FormsAuthentication` のクッキーから ASP.NET Core のデータ保護クッキーへ移った場合。いずれにせよ既存セッションは無効になります。

実務的な計画としては、切り替え後の 1 週間は別スロットで .NET Framework のデプロイをウォームのまま保持し、切り替えはデプロイ時ではなくロードバランサー側の機能フラグでゲートします。それ以降は前進修正に切り替えます。

## ハマりどころ

- **.NET 11 の `HttpClient` は TLS の Server Name Indication を厳格に強制します。** 一致する SAN を持たない証明書を提示する内部サービスへの呼び出しは `AuthenticationException` で失敗します。証明書を修正するか、`SslOptions.RemoteCertificateValidationCallback` を意図的に設定してください。.NET Framework のデフォルトは緩く、SAN の欠落を覆い隠していました。
- **.NET 11 の `DateTime.Parse` は曖昧な形式について .NET Framework 4.8 より厳密です。** 明示的な `IFormatProvider` を渡さずに `DateTime` を文字列経由でラウンドトリップしていたコードは、以前は受理されていた入力に対して `FormatException` を投げ始めます。常に `CultureInfo.InvariantCulture` と既知の形式を渡してください。日付が JSON 経由で届く最も一般的なバリエーションは、[JSON value could not be converted to System.DateTime fix](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) が扱っています。
- **`Microsoft.Data.SqlClient` が現代的な経路では `System.Data.SqlClient` を置き換えます。** EF Core 11 は `Microsoft.Data.SqlClient` 7.x 以降を要求します。古い `System.Data.SqlClient` への推移的なピン留めはコンパイルは通りますが、最新の SQL Server ボックスに対する TLS 1.3 ネゴシエーション時に実行時に失敗します。
- **構成バインディングは JSON では大文字小文字を区別し、`app.config` では区別しません。** `appsettings.json` の `MaxRetries` という名前のプロパティは、`maxretries` というキーからはバインドされません。.NET Framework の `ConfigurationManager` は気にしませんでした。
- **`HostingEnvironment.MapPath` はなくなりました。** `IWebHostEnvironment.ContentRootPath` と `Path.Combine` で置き換えてください。`~/` の仮想パス構文は ASP.NET Core のどこでも解釈されません。
- **WCF のデータコントラクトサロゲートは CoreWCF を通しても完全に同一のラウンドトリップにはなりません。** `IDataContractSurrogate` に依存している場合は、オブジェクトの等価性だけでなく、移行前後の正確なワイヤ形式をアサートするコントラクトテストを書いてください。

## 関連記事

- [.NET 8 から .NET 11 へ移行する: 完全チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [.NET 11 における Native AOT vs ReadyToRun vs JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [ASP.NET Core 11 における Minimal API vs コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [2026 年の System.Text.Json vs Newtonsoft.Json](/ja/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)
- [一括挿入における EF Core 11 vs Dapper: 実ベンチマーク](/ja/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## 参考資料

- [.NET Framework から .NET への移植の概要](https://learn.microsoft.com/en-us/dotnet/core/porting/)
- [.NET 11 の破壊的変更](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [.NET Upgrade Assistant のドキュメント](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)
- [CoreWCF プロジェクトと互換性マトリクス](https://github.com/CoreWCF/CoreWCF)
- [ASP.NET から ASP.NET Core への移行](https://learn.microsoft.com/en-us/aspnet/core/migration/proper-to-2x/)
- [AssemblyLoadContext API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.loader.assemblyloadcontext)
