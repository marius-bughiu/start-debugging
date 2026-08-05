---
title: "解決: IIS へのデプロイ後に発生する HTTP Error 500.30 - ASP.NET Core app failed to start"
description: "500.30 は、アプリが w3wp.exe の中で起動中に例外をスローしたという意味です。実際の例外は Windows のアプリケーション イベント ログに IIS AspNetCore Module V2 として既に記録されています。まずそれを読み、次に原因を順に絞り込みます。共有フレームワークの未インストール、アプリケーション プールの x86/x64 不一致、構成の欠落、プールの権限です。"
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "iis"
  - "deployment"
lang: "ja"
translationOf: "2026/08/fix-http-error-500-30-aspnet-core-app-failed-to-start-on-iis"
translatedBy: "claude"
translationDate: 2026-08-05
---

`500.30` は原因ではありません。ASP.NET Core Module が `w3wp.exe` の中で CLR を起動したものの、リッスンを開始する前にアプリが例外をスローしたことを IIS が報告しているだけです。実際の例外は、ほぼ確実にサーバー上に既に存在します。イベント ビューアーを開き、**Windows ログ > Application** に移動して、ソースが **IIS AspNetCore Module V2** である最新のエントリを探してください。`stdoutLogEnabled` が `false` のとき、モジュールは起動時のエラーを取得し、そのイベントに最大 30 KB まで、スタックトレースを含めて書き込みます。エントリに `exception code = '0xe0434352'` しか書かれていない場合は、`web.config` で `stdoutLogEnabled="true"` を設定し、もう一度サイトにアクセスしてください。その先は、実際に原因となる 4 つの要素を順位付けしていく作業です。

```text
HTTP Error 500.30 - ASP.NET Core app failed to start
```

古いビルドの ASP.NET Core Module は、まったく同じ失敗を `HTTP Error 500.30 - ANCM In-Process Start Failure` と表示します。この文字列は Microsoft のドキュメントのエラー一覧で今も使われています。どちらも意味は同じです。以下の内容はすべて、現行の .NET Hosting Bundle に含まれる ANCM V2 を用いて .NET 11 (Preview 6、SDK `11.0.100-preview.6.26359.118`) で検証しています。この仕組みは ASP.NET Core 3.0 で in-process ホスティングが既定になって以来変わっていないため、各手順は `net8.0`、`net9.0`、`net10.0` のデプロイにもそのまま当てはまります。

## 500.30 が診断ではなく症状である理由

ASP.NET Core 3.0 以降、アプリは既定で **in-process ホスティング モデル** を使用します。MSBuild プロパティ `<AspNetCoreHostingModel>` の既定値は `InProcess` で、`dotnet publish` は `web.config` に `hostingModel="inprocess"` を書き込みます。このモデルでは別プロセスの `dotnet.exe` は存在しません。`aspnetcorev2.dll` が in-process リクエスト ハンドラーを IIS ワーカー プロセスに読み込み、そこで CoreCLR を起動し、`Program.cs` は Kestrel ではなく `IISHttpServer` を使って `w3wp.exe` の内部で実行されます。

これによりプロセスは 2 つではなく 1 つになり、スループットも実際に向上しますが、エラー報告は崩壊します。`app.Run()` がリッスン状態に達する前にアプリが例外をスローすると、モジュールは自身のプロセス内に死んだ CLR を抱え、ブラウザーに渡せる情報は 1 バイト分、つまり「起動に失敗した」だけになります。だからこそ、接続文字列の欠落、64 ビット ワーカー内の 32 ビット バイナリ、未インストールのランタイム、データ保護キー リングに対する `DirectoryNotFoundException` のすべてが、単一のステータス コードに集約されるのです。

何かを変更し始める前に、2 つの帰結を理解しておく価値があります。

- **`startupTimeLimit` は再起動してくれません。** in-process でホストしている場合、モジュールの既定の起動待ち時間である 120 秒が経過するとプロセスは強制終了され、再起動は *されません*。`rapidFailsPerMinute` も適用されません。out-of-process ホスティングは次のリクエストで再試行しますが、in-process はしません。
- **アプリケーション プールは共有できません。** in-process ホスティングはアプリごとに 1 つのプールを必要とします。1 つのプールに in-process アプリを 2 つ入れると `500.35` になり、in-process と out-of-process を 1 つのプールに混在させると `500.34` になります。

## 最小の再現

これを再現する最小のデプロイは、ローカルには存在してサーバーには存在しない構成を読むアプリです。

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

string cs = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("Connection string 'Default' is missing.");

builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlServer(cs));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();
```

ローカルで動作するのは、`appsettings.Development.json` にそのセクションがあり、`ASPNETCORE_ENVIRONMENT` が `Development` だからです。サーバーでは環境が `Production` で、`appsettings.Production.json` は発行出力に一度も追加されておらず、3 行目で例外が発生します。F5 は通り、デプロイは 500.30 を返し、それでいてアプリ自体には何の問題もありません。

この形は実際の 500.30 報告のかなりの割合を占めます。障害が環境依存であるため、構造上、開発マシンでは見えないのです。

## アプリケーション イベント ログを読む。たいていはこれで調査が終わります

`web.config` に触れる前にこれを行ってください。サーバーでイベント ビューアーを管理者として実行し、**Windows ログ > Application** を開くか、直接クエリします。

```powershell
# Windows Server 2022+, PowerShell 5.1 or 7.x. Run elevated on the web server.
Get-WinEvent -FilterHashtable @{
    LogName      = 'Application'
    ProviderName = 'IIS AspNetCore Module V2'
} -MaxEvents 5 | Format-List TimeCreated, Id, LevelDisplayName, Message
```

探しているのは次の 3 つのパターンのいずれかです。

**パターン 1、有用なもの。** 完全なマネージド スタックトレースです。`stdoutLogEnabled` が `false` であるため、モジュールが未処理の起動時例外を取得してイベント ログに出力しています。例外の型と最上位のフレームを読み、そこを直せば終わりです。ブラウザーのページが何も教えてくれなかったのでサーバーも同じだろうと決めつけ、多くの人が見落とすのがこのケースです。

**パターン 2、不透明なもの。**

```text
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
hit unexpected managed exception, exception code = '0xe0434352'.
Please check the stderr logs for more information.
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
failed to load clr and managed application. CLR worker thread exited prematurely
```

`0xe0434352` は「マネージド例外が外に出た」ことを示す汎用の Win32 コードで、それ以上の意味はありません。型もメッセージも持ちません。これは 32 ビット アプリケーションが有効になっていないプールに x86 アプリを配置したときの文書化されたシグネチャですが、モジュールが詳細を取得できない場所で例外が抜けた場合にも現れます。次は stdout ログに進んでください。

**パターン 3、何もない。** リクエストから 1 分以内に ANCM のイベントが 1 件もない場合です。これはたいてい、モジュールが CLR の起動まで到達していないことを意味し、実際には起動時例外ではなく `500.0`、`500.31`、`500.32` を見ていることになります。末尾の派生パターンのセクションを参照してください。

## stdout ログを有効にする

プロジェクト内のものではなく、サーバー上にデプロイされた `web.config` を編集します。このファイルは発行のたびに再生成されるので、一時的な診断スイッチとしてはまさに好都合です。

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Deployed web.config, ASP.NET Core Module V2, .NET 11 -->
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath="dotnet"
                  arguments=".\MyApp.dll"
                  stdoutLogEnabled="true"
                  stdoutLogFile=".\logs\stdout"
                  hostingModel="inprocess" />
    </system.webServer>
  </location>
</configuration>
```

`web.config` を保存するとアプリケーション プールがリサイクルされるので、もう一度サイトにリクエストするだけで済みます。`stdoutLogFile` 用の `logs` フォルダーはモジュール自身が作成し、タイムスタンプとプロセス ID を含む名前のファイル、たとえば `stdout_20260805184032_5412.log` を書き出します。アプリケーション プール ID にはそのフォルダーへの書き込み権限が必要です。

```console
icacls "C:\inetpub\wwwroot\myapp\logs" /grant "IIS AppPool\MyAppPool":(OI)(CI)M
```

時間を節約できる読み方のポイントが 3 つあります。

- **ファイルは存在するが空である。** プロセスは stdout に何かを書き出す前に死んでいます。これはアーキテクチャの不一致かネイティブ読み込みの失敗を示しており、あなたのコードの問題ではありません。
- **通常の起動ログが並び、そこで途切れている。** 最後の行の直後に実行される処理が容疑者です。
- **必ず元に戻すこと。** `stdoutLogEnabled="true"` はプロセスがリサイクルされるたびに新しいファイルを永久に作り続けます。有効なままにするとアプリやサーバーを停止させかねないと、ドキュメントは明言しています。答えが得られたら `false` に戻してください。

stdout がそれでも沈黙している場合、障害はマネージド コードより下の層にあります。モジュール自身のデバッグ ログを追加します。

```xml
<!-- ASP.NET Core Module V2 diagnostic logging. Remove after troubleshooting. -->
<aspNetCore processPath="dotnet"
            arguments=".\MyApp.dll"
            stdoutLogEnabled="false"
            stdoutLogFile=".\logs\stdout"
            hostingModel="inprocess">
  <handlerSettings>
    <handlerSetting name="debugFile" value=".\logs\aspnetcore-debug.log" />
    <handlerSetting name="debugLevel" value="FILE,TRACE" />
  </handlerSettings>
</aspNetCore>
```

`stdoutLogFile` とは異なり、モジュールは `debugFile` 用のフォルダーを **作成しません**。`logs` ディレクトリはあらかじめ存在し、プール ID が書き込める必要があります。そうでないと何も得られず、誤った結論に至ります。このログには hostfxr の解決、検討されたフレームワークのバージョン、読み込みに失敗した DLL が記録されます。

## 対処 1: アプリが起動中に例外をスローした。これが大半です

イベント ログか stdout ログでスタックトレースが得られたなら、これがあなたのケースです。実務上の分類は次のとおりです。

1. **ローカルには存在し、サーバーには存在しない構成。** `appsettings.Production.json` が発行出力に含まれていない、本番相当が存在しない User Secrets の値、自分のマシンにだけ設定された環境変数などです。これは [接続文字列が見つからない失敗](/ja/2026/05/fix-no-connection-string-named-defaultconnection/) のデプロイ版です。
2. **`builder.Build()` での DI グラフの失敗。** ASP.NET Core は Development でビルド時にスコープとサービス グラフを検証するため、`Unable to resolve service for type` やキャプティブ依存の問題は、親切なページではなく 500.30 として表面化します。[unable to resolve service for type while attempting to activate](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) と [cannot consume scoped service from singleton](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) を参照してください。
3. **起動時に接続する外部依存。** アプリケーション プールのマネージド ID をカバーしていないアクセス ポリシーの Key Vault は、Microsoft が 500.30 について名指しで挙げているケースです。起動時に実行するマイグレーション、データベースに接続する構成プロバイダー、外向き通信のないサーバーでの OIDC ディスカバリ ドキュメントの取得。いずれもネットワークの問題を起動失敗に変えます。
4. **証明書とデータ保護へのアクセス。** マシン ストアからの X.509 証明書の読み込みや、プール ID が書き込めないパスへのデータ保護キー リングの永続化は、最初のリクエストより前に例外をスローします。

このカテゴリ全体に対する構造的な対処は、起動失敗を偶発的なものではなく明示的で読めるものにすることです。[`IValidateOptions<T>` と `ValidateOnStart` による起動時の構成検証](/ja/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) は、「アプリが 500.30 を返す」を、どの設定が欠けているかを正確に列挙する名前付きの `OptionsValidationException` に変えます。これは 5 分で終わる修正と、午後をまるごと使う調査との違いです。

ステージング環境のブラウザーで生の例外を確認したい場合は、環境変数を `web.config` に追加します。公開サーバーでは絶対に行わないでください。

```xml
<!-- Staging and test servers only. Do not ship this to an internet-facing host. -->
<aspNetCore processPath="dotnet" arguments=".\MyApp.dll" hostingModel="inprocess">
  <environmentVariables>
    <environmentVariable name="ASPNETCORE_ENVIRONMENT" value="Development" />
    <environmentVariable name="ASPNETCORE_DETAILEDERRORS" value="true" />
  </environmentVariables>
</aspNetCore>
```

## 対処 2: アプリが対象とする共有フレームワークがインストールされていない

Microsoft は 500.30 の原因としてこれを最初に挙げています。アプリが、存在しないバージョンの ASP.NET Core 共有フレームワークを対象にしているケースです。サーバーに実際に何があるかを確認します。

```console
dotnet --list-runtimes
```

`TargetFramework` とメジャー バージョンが一致する `Microsoft.AspNetCore.App` の行が必要で、しかもアプリケーション プールと同じアーキテクチャである必要があります。アプリが `net11.0` でサーバーの最新が `Microsoft.AspNetCore.App 10.0.x` までなら、それが答えです。ASP.NET Core は既定でメジャー バージョンをまたいだロールフォワードを行いません。

**.NET Hosting Bundle** をインストールしてください。ランタイム、ASP.NET Core 共有フレームワーク、ANCM が 1 つのパッケージで入ります。ダウンロードそのものよりも多くの 500.30 を生んでいるのは、次の 2 つのインストール規則です。

- **Hosting Bundle より先に IIS をインストールする必要があります。** バンドルを先に入れてしまった場合、インストーラーを再実行して修復するのは任意ではなく必須です。
- **インストール後に Web サーバーを再起動します。** インストーラーはシステムの `PATH` を変更し、また ASP.NET Core は共有フレームワーク パッケージのパッチ リリースについてもロールフォワードを行わないため、バンドルを更新するたびに同じ再起動が必要です。

```console
net stop was /y
net start w3svc
```

完全な `iisreset` でも構いません。この手順を飛ばすことが、「ランタイムを入れたのにまだ失敗する」という続きが非常に多い理由です。

## 対処 3: アプリとアプリケーション プールのビット数が食い違っている

in-process ホスティングでは、アプリとインストール済みランタイムのアーキテクチャがアプリケーション プールのアーキテクチャと一致している必要があります。適合レイヤーは存在しません。32 ビットのバイナリが 64 ビットの `w3wp.exe` の中で CoreCLR を起動することはできません。

IIS マネージャーでアプリケーション プールを選択し、**詳細設定** を開いて **32 ビット アプリケーションの有効化** を設定します。

- x86 アプリの場合は `True`。32 ビット SDK で発行した x86 の自己完結型デプロイも含みます。
- x64 アプリの場合は `False`。

コマンド ラインからであれば次のとおりです。

```console
%windir%\system32\inetsrv\appcmd set apppool /apppool.name:MyAppPool /enable32BitAppOnWin64:false
```

ついでに、基本設定で **.NET CLR バージョン** を **マネージド コードなし** に設定してください。ASP.NET Core は自分で CoreCLR を起動するため、ワーカーにデスクトップ CLR が読み込まれる必要はまったくありません。ドキュメント上は任意ですが推奨とされており、レガシー モジュールとの紛らわしい相互作用を一括して取り除けます。

Hosting Bundle 固有の落とし穴が 1 つあります。`OPT_NO_X86=1` を付けてインストールした場合、そのマシンには 32 ビット ランタイムがまったく存在しないため、プールの設定に関係なく x86 アプリは失敗します。

## 対処 4: アプリケーション プール ID が必要なものを読めない

既定の `ApplicationPoolIdentity` は仮想アカウントであり、権限が原因の 500.30 は他のあらゆる 500.30 とまったく同じ見え方をします。ID が `ApplicationPoolIdentity` からドメイン アカウントやサービス アカウントに変更されている場合は、デプロイ フォルダーへの読み取り権限と、アプリが書き込むすべての場所への書き込み権限があるか確認してください。プール名を使ってフォルダーに権限を付与します。

```console
icacls "C:\inetpub\wwwroot\myapp" /grant "IIS AppPool\MyAppPool":(OI)(CI)RX
```

直接確認する価値がある事例が 2 つあります。マシン ストアから証明書の秘密鍵を読むにはキー コンテナーへの ACL が必要であること、そして `%USERPROFILE%` に触れるコードにはアプリケーション プールの **ユーザー プロファイルの読み込み** が `True` である必要があることです。既定では `True` ですが、堅牢化された環境ではしばしば無効化されています。

## IIS の外でアプリを実行して調査範囲を半分にする

IIS の構成にさらに 1 時間費やす前に、サーバーにログオンし、デプロイ フォルダーでシェルを開き、アプリを直接実行してください。

```console
cd C:\inetpub\wwwroot\myapp
set ASPNETCORE_ENVIRONMENT=Production
dotnet MyApp.dll
```

例外は完全なスタックトレース付きでコンソールに出力され、ログ出力の設定は一切必要ありません。ここでスローされるなら問題はアプリかその構成にあり、IIS は無実です。そのまま対処 1 に進んでください。きれいに起動して `http://localhost:5000` で応答するなら、問題はホスティング層、つまりビット数、権限、モジュールのいずれかであり、対処 2、3、4 に進みます。このコマンド 1 つで、この記事のどちらの半分が必要かが決まります。

環境変数に注意してください。自分のアカウントと自分の環境で実行することは、プール ID として実行することとは異なります。したがって、ここで正常に動いてもファイル権限が正しいことの証明にはなりません。証明されるのは、コードとデプロイされた構成ファイルが正しいということだけです。

## 500.30 ではない近隣のコード

500.30 の検索流入には、よく似た別のケースが多数含まれます。ページに別の表示が出ているなら、それは別の問題であり、対処も別です。

- **`500.0 - ANCM In-Process Handler Load Failure`**: モジュールが in-process リクエスト ハンドラーをそもそも読み込めませんでした。`processPath` の誤り、Hosting Bundle の未インストール、インストール後に IIS を再起動していない、VC++ 再頒布可能パッケージの欠落などです。
- **`500.31 - ANCM Failed to Find Native Dependencies`**: `Microsoft.NETCore.App` または `Microsoft.AspNetCore.App` がインストールされていません。イベント ログには、見つからなかったフレームワークとバージョンが正確に記載されます。インストールするか、ターゲットを変更するか、自己完結型で発行してください。
- **`500.32 - ANCM Failed to Load dll`**: プロセッサ アーキテクチャの不一致です。対処 3 と同じ根本原因が 1 層下で表面化したものです。
- **`500.33 - ANCM Request Handler Load Failure`**: アプリが `Microsoft.AspNetCore.App` フレームワークを参照していません。`.runtimeconfig.json` を確認してください。`Microsoft.NET.Sdk.Web` ではなく `Microsoft.NET.Sdk` を使ったコンソール アプリでこれが起こります。
- **`500.34` と `500.35`**: ホスティング モデルの混在、または 1 つのプールに in-process アプリが 2 つある状態です。別々のプールに分けてください。
- **`500.36 - ANCM Out-Of-Process Handler Load Failure`**: `aspnetcorev2.dll` の隣に `aspnetcorev2_outofprocess.dll` がありません。Hosting Bundle を修復してください。
- **`500.37 - ANCM Failed to Start Within Startup Time Limit`**: 起動が 120 秒を超えました。`startupTimeLimit` を引き上げるか、同一マシン上で CPU を奪い合う多数のアプリの起動時刻をずらしてください。
- **`500.38 - ANCM Application DLL Not Found`**: 単一ファイルの実行可能ファイルとして発行しており、in-process ホスティングはこれをサポートしません。`<PublishSingleFile>false</PublishSingleFile>` を設定するか、`<AspNetCoreHostingModel>OutOfProcess</AspNetCoreHostingModel>` に切り替えてください。
- **`502.5 - Process Failure`**: out-of-process ホスティング専用です。バックエンド プロセスの起動に失敗したか、`%ASPNETCORE_PORT%` でのリッスンに失敗しました。RID の不一致による `BadImageFormatException` が多く、stdout ログで確認できます。
- **`500.19`**: `web.config` そのものを読む段階での IIS の構成エラーです。たいていは ANCM が登録されていないか、構成が不正です。アプリは登場すらしていません。

out-of-process ホスティングへの切り替えは、対処というより正当な診断手段です。`web.config` に `hostingModel="outofprocess"` を設定するとワーカーがリサイクルされ、アプリは子プロセスの `dotnet.exe` として実行されます。この状態では起動失敗の観測がはるかに容易で、`requestTimeout` と `rapidFailsPerMinute` も再び有効になります。読める形のエラーを得るために使い、その後は性能のために in-process へ戻してください。

500.30 の調査は、順番どおりに進めれば短時間で終わります。イベント ログ、次にコンソールからの実行、次にビット数とランタイムです。長い午後になるのは、ブラウザーのページから始めて推測に頼ったときだけです。

## 関連記事

- [Fix: Unable to resolve service for type X while attempting to activate Y](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)：500.30 の裏に隠れている最も一般的なマネージド例外です。
- [Fix: Cannot consume scoped service from singleton](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)：コンテナーが構築された後にのみ現れる、もう 1 つの DI の失敗を扱います。
- [.NET 11 で IValidateOptions&lt;T&gt; を使って起動時にオプションを検証する方法](/ja/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/)：「アプリが起動しない」を、どの設定が誤っているかを示す名前付き例外に変えます。
- [Fix: No connection string named 'DefaultConnection' could be found](/ja/2026/05/fix-no-connection-string-named-defaultconnection/)：デプロイ直前まで生き残る典型的な構成の抜けです。
- [Fix: 発行済みアプリでの Could not load file or assembly](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)：起動失敗として現れる発行出力の問題を扱います。
- [.NET 8 から .NET 11 への移行: 完全チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)：メジャー バージョンの更新がすべての IIS サーバーで要求する Hosting Bundle の更新手順を含みます。

## 参考資料

- [Troubleshoot ASP.NET Core on Azure App Service and IIS](https://learn.microsoft.com/en-us/aspnet/core/test/troubleshoot-azure-iis) (MS Learn)。500.30 から 500.38 の定義、stdout ログ、ANCM デバッグ ログについて。
- [Common error troubleshooting for Azure App Service and IIS with ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/azure-iis-errors-reference)。`0xe0434352` のシグネチャを含む、アプリケーション ログの文字列そのものについて。
- [ASP.NET Core Module (ANCM) for IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/aspnet-core-module)。`aspNetCore` 要素の属性、その既定値、in-process ホスティングの特性について。
- [Host ASP.NET Core on Windows with IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/)。Hosting Bundle のインストール順序、`net stop was /y`、アプリケーション プールの構成について。
- [Install the .NET Hosting Bundle](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/hosting-bundle)。`OPT_NO_X86` を含むインストーラーのオプションについて。
