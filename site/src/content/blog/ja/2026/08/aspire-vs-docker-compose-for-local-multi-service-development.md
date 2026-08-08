---
title: "Aspire と Docker Compose の比較: 複数サービスのローカル開発"
description: "Aspire 13.4.6 はプロジェクトをデバッグ可能なホストプロセスとして実行するため .NET の内側のループで有利であり、Docker Compose は compose ファイルが CI とデプロイの契約も兼ねている場合に有利です。両者の起動時間と編集から実行までの実測値、それぞれが自動で注入する構成、そして判断を決める6つの落とし穴を解説します。"
pubDate: 2026-08-08
template: vs
tags:
  - "comparison"
  - "aspire"
  - "docker"
  - "dotnet"
  - "devops"
lang: "ja"
translationOf: "2026/08/aspire-vs-docker-compose-for-local-multi-service-development"
translatedBy: "claude"
translationDate: 2026-08-08
---

ローカルで実行するサービスが、自分でソースからビルドする .NET プロジェクトであれば Aspire を選んでください。Aspire はそれらを通常のホストプロセスとして実行するため、デバッガーがすべてに一度にアタッチでき、本来なら手で書くことになる接続文字列や OpenTelemetry の構成を注入してくれます。`docker-compose.yaml` が CI、ステージング、または本番の契約も兼ねている場合、あるいはスタックの大半が自分では書かない既製のイメージである場合は Docker Compose を選んでください。どちらか一方に決める必要はありません。`aspire publish` は同じモデルから compose ファイルを生成します。以下の数値と API はすべて Aspire 13.4.6 (2026-06-20 に公開された現行の安定版) と Docker Compose v5.1.4 を .NET 10 上で使った結果です。

名前についての注記です。この製品は 2025年11月の Aspire 13 で ".NET" という接頭辞を外したため、".NET Aspire" と "Aspire" は同じものを指します。また `dotnet workload install aspire` という手順は Aspire 9.0 の時点でなくなっています。

## 比較表

| | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| 構成の記述形式 | C# または TypeScript | YAML |
| 自作の .NET サービスの実行形態 | DCP が起動するホストプロセス | Dockerfile からビルドされたコンテナ |
| デバッガーのアタッチ | F5 で全プロジェクトに一度に | リモートデバッガーをサービスごとに構成 |
| 接続文字列 | `ConnectionStrings__<name>` として注入 | 自分で書く |
| サービス間の URL | `services__<name>__<scheme>__0` として注入 | サービス名によるコンテナ DNS |
| テレメトリ | OTLP エンドポイントと dashboard、構成不要 | なし |
| 起動順序 | `WaitFor()` と health checks | `depends_on` と `condition: service_healthy` |
| カスタムネットワーク | 同等の機能なし | `networks:` |
| CPU とメモリの上限 | モデル化されていない | `deploy.resources` |
| コンテナ名 | ランダムなサフィックス (`cache-mmsmckhq`) | 決定的 (`<project>-cache-1`) |
| デプロイ成果物になるか | ならない。AppHost は開発時専用 | しばしばなる |
| .NET 以外のサービス | Node、Bun、Python、Go、または任意のコンテナ | 任意のコンテナ |

## それぞれが実際に起動するもの

ここがすべての違いの出発点です。Compose が起動するのはコンテナだけです。ファイル内のすべてのサービスは、いま編集しているものも含めて、実行する前にビルドしなければならないイメージです。

Aspire の AppHost が起動するのは混成です。`AddProject<T>` で宣言したものは Developer Control Plane の管理下で、あなたのマシン上の普通のプロセスとして動きます。コンテナになるのは、自分で書いたのではないもの、つまり `AddContainer`、`AddRedis`、`AddPostgres` などで宣言したものだけです。アプリケーションの実行中に `docker ps` を見ると分かります。

```
NAMES              IMAGE
cache-mmsmckhq     redis:8.6
```

これが2サービス構成のアプリケーションにおけるコンテナの全リストです。API は `dotnet` プロセスであり、だからこそ Visual Studio や Rider がリモートデバッグの設定を一切せずにブレークポイントを置けますし、だからこそ再ビルドに Docker がまったく関与しません。

## 同じスタックを二通りで書く

minimal API と Redis です。まず Compose 版です。

```yaml
# docker-compose.yaml -- Docker Compose v5.1.4
services:
  cache:
    image: redis:8.2
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 15

  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - ConnectionStrings__cache=cache:6379
    ports:
      - "8080:8080"
    depends_on:
      cache:
        condition: service_healthy
```

これに加えて Dockerfile が必要で、これは省略できませんが、ここには載せていません。次が Aspire 版で、こちらはファイル全体です。

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6, .NET 10
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithHttpEndpoint(port: 8080, name: "public")
       .WithReference(cache)
       .WaitFor(cache);

builder.Build().Run();
```

プロジェクトファイルで意味のある行は3行です。13.4.6 のテンプレートが SDK を入れ子の `<Sdk>` 要素ではなく `Sdk` 属性に書くようになった点に注目してください。

```xml
<!-- AppHost/AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Aspire.AppHost.Sdk/13.4.6">
  <ItemGroup>
    <ProjectReference Include="..\Api\Api.csproj" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.Redis" Version="13.4.6" />
  </ItemGroup>
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

どちらのスタックも同じ `Program.cs` を実行し、構成から `ConnectionStrings:cache` を読み取ります。Compose ではその値を自分で与えました。Aspire では与えていません。

## Aspire がプロセスに書き込むもの

主要な環境変数をダンプするデバッグ用エンドポイントを追加してから AppHost を実行しました。私の側の構成は一行も書かずに、API プロセスが受け取ったのが次の内容です。

```
ASPNETCORE_URLS=https://localhost:61681;http://localhost:61682;http://localhost:61683
ConnectionStrings__cache=localhost:58390,password=T9bjFegjra6EBk5HG3M9uq
OTEL_EXPORTER_OTLP_ENDPOINT=https://localhost:21089
OTEL_EXPORTER_OTLP_HEADERS=x-otlp-api-key=566b726e1f4c36c1b4e0474e80db9cd5
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_METRIC_EXPORT_INTERVAL=1000
OTEL_SERVICE_NAME=api
OTEL_TRACES_SAMPLER=always_on
```

注目すべき点が2つあります。Aspire は Redis のパスワードを生成して接続文字列に入れているため、compose ファイルの `redis:8.2` のように、ローカルのキャッシュがよく知られたポートで認証なしに開いたままにはなりません。もう1つ、OTLP のブロックがあるおかげで、トレースとメトリクスが何もせずに dashboard に表示されます。同じことを Compose でやりたければ、コレクターを立ててエクスポーターを自分で配線することになり、それだけで [.NET 11 と無料のバックエンドで OpenTelemetry を使う方法](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) という記事1本分になります。

プロジェクト間の参照では、注入される変数は `services__<name>__<scheme>__0` の形式で、たとえば `services__basket__https__0` となり、.NET のサービスディスカバリーがこれを使って `https://basket` を解決します。

## 計測結果

同じマシン、同じアプリケーション、同じ Redis です。Intel Core Ultra 7 265KF (20 コア)、32 GB RAM、Windows 11 Pro 26200、Docker 29.5.3 と Compose v5.1.4、.NET SDK 10.0.201、Aspire CLI 13.4.6 です。ベースイメージは計測前に取得済みなので、どの計測にもレジストリからのダウンロードは含まれません。計測しているのは、コマンドの開始から、アプリケーションへの HTTP GET が新しくビルドされたコードを返すまでの実時間で、250 ms ごとにポーリングしています。編集内容は `Program.cs` の文字列リテラルを1行変えるだけで、キャッシュから返される可能性を排除するため各ラウンドで新しい値を使っています。

| シナリオ | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| コールドスタート: 未ビルドの状態からスタックが応答するまで | 15.5 秒 (`dotnet clean` の後に `aspire run`) | 10.8 秒 (`build --no-cache` に 7.0 秒、`up` に 3.8 秒) |
| C# の1行変更から新しいコードを返すまで | 14.6 / 13.9 / 11.0 秒、中央値 13.9 秒 | 5.4 / 5.6 / 5.3 秒、中央値 5.4 秒 |

Docker Compose がすべての行で勝ちました。これを取り繕うつもりはありません。ここから結論を出す前に、なぜそうなるのかを理解しておく価値があります。

ここでの Compose のループは、3秒ほどの増分 `docker build` (restore のレイヤーはキャッシュされ、再実行されるのは `COPY` と `dotnet publish` だけです) とコンテナの再作成であり、対象は発行後の出力が自分のコード約10キロバイトというアプリケーションです。Aspire のループは `aspire resource api stop`、MSBuild の完全な実行、そして `aspire resource api start` であり、これほど小さなプロジェクトでは MSBuild 自体の起動コストが支配的になります。Compose の数値は再ビルドするイメージレイヤーの大きさとともに増え、Aspire の数値は MSBuild のグラフとともに増えます。この2つの曲線がどこで交差するかは計測していないので、交差点について主張するつもりはありません。

より重要な但し書きは、Aspire の行が CLI で計測されている点です。そして CLI は、多くの人が実際に Aspire を使うやり方ではありません。Visual Studio や Rider でのループは F5 と Hot Reload であり、これは実行中のプロセスにパッチを当てるだけで再ビルドを一切しません。コンテナ化されたサービスにこれと同等のものはありません。`docker compose watch` はファイルを同期するかイメージを再ビルドするだけで、実行中のプロセスにパッチを当てるわけではないからです。したがってこの表は、Aspire の内側のループについては上限、Compose については妥当な実測値として読んでください。

## Docker Compose が正解になるとき

- **compose ファイルが成果物である場合。** CI が同じ YAML を立ち上げる、QA のマシンがそれを実行する、オンコールの runbook に `docker compose up` と書いてある。そうであれば Compose は単なる開発ツールではなく、AppHost に置き換えることは同じシステムの記述を2つ維持することを意味します。
- **サービスをほとんど自分でビルドしない場合。** Kafka、MinIO、Keycloak、そして初期化スクリプトを3つ持つ Postgres というスタックは、イメージのスタックです。Aspire もそれらをコンテナとしてモデル化できますが、YAML のままで十分だったものの上に C# の抽象化を払うことになります。
- **ネットワークやリソース上限が必要な場合。** Aspire にはカスタムネットワークの分離に相当する機能がなく、すべてのリソースは名前で到達可能です。サービス A がサービス B に本当に到達できないときに何が起きるかを試したい場合や、`deploy.resources` でコンテナを1 CPU に制限したい場合、Compose にはそれができて Aspire にはできません。
- **チームが .NET 中心ではない場合。** Aspire 13.4 で TypeScript の AppHost が一般提供になり、`AddGoApp` と `AddBunApp` が追加されたので、1年前ほどこの点は当てはまりません。それでもドキュメント、サンプル、統合のカタログは依然として .NET が中心です。

## Aspire が正解になるとき

- **複数のサービスを同時にデバッグする場合。** これが単独で最大の理由です。API と worker のブレークポイントを F5 一発で、`docker-compose.debug.yml` もイメージ内の `vsdbg` もポートのやりくりも不要です。
- **開発スタックに構成が面倒なバックエンドサービスがある場合。** `AddPostgres("db").AddDatabase("orders")` だけで、コンテナ、生成されたパスワード、正しい .NET 形式の接続文字列、そして health checks で守られた起動が手に入ります。Compose での同等物は15行と `.env` ファイルです。
- **内側のループでテレメトリが欲しい場合。** dashboard は実行ボタンを押した瞬間から、サービスをまたぐトレース、構造化ログ、メトリクスを表示します。N+1 やリトライの嵐をステージングではなく自分のマシンで見つけられることは、コードの書き方を変えます。これまでログファイルから [EF Core 11 で N+1 クエリを検出](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) していたのなら、これは実質的な改善です。
- **すでに段階的に導入している場合。** Aspire は既存のソリューションに新しいプロジェクト2つとして入ります。これは [既存の ASP.NET Core ソリューションに Aspire を追加する方法](/ja/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) のテーマです。

## 判断を決める落とし穴

**Compose のポート記法はそのままでは移せません。** `ports: ["8080:8080"]` は `WithHttpEndpoint(port: 8080, targetPort: 8080)` に見えますが、この組み合わせは起動時に例外を投げます。

```
System.InvalidOperationException: The endpoint 'public' for resource 'api'
requested a proxy (IsProxied is true). Non-container resources cannot be
proxied when both TargetPort and Port are specified with the same value.
```

Aspire はプロジェクトのエンドポイントをプロキシするため、ホスト側のポートとターゲットのポートに同じ値を指定できません。`port:` だけを指定して、ターゲットは自動で選ばせてください。

**`WithReference` は `depends_on` ではありません。** 移行ガイドは明確です。`WithReference()` が構成するのはサービスディスカバリーと接続文字列だけで、起動順序は制御しません。Compose の `condition: service_healthy` に相当する挙動が欲しいなら必要なのは `WaitFor()` であり、しかも `WithReference()` の代わりではなく、それに加えて必要です。

**コンテナ名は安定していません。** Compose はプロジェクト名とサービス名から導出した `bench-cache-1` を与えます。Aspire は3回の実行で `cache-vvkhtnuf`、`cache-zwjpvzxh`、`cache-mmsmckhq` を割り当てました。`docker exec -it myapp-cache-1 redis-cli` を前提にしたスクリプトやチームの習慣は壊れます。

**既定のイメージバージョンは Aspire のバージョンとともに動きます。** 13.4.6 の `AddRedis` が取得したのは `redis:8.6` であり、compose ファイルで固定していた `redis:8.2` ではありませんでした。Aspire 13.4 では Postgres の既定も 17.6 から 18.3 に移りましたが、これは既存のデータボリュームと互換性がありません。気にするなら `WithImageTag` で固定してください。

**Compose のビルドコンテキストには `.dockerignore` が必要です。** これがないと `COPY Api/ Api/` がホストの `bin/` と `obj/` をビルドコンテキストに送り込み、毎回のビルドを膨らませ、ソースに触れていない変更でもレイヤーを無効化します。2行で解決し、その差はビルドログに表れます。このプロジェクトではコンテキストの転送量が 1.18 kB まで下がりました。

```
# .dockerignore
**/bin
**/obj
```

Aspire はプロジェクトのイメージを一切ビルドしないので、これに相当する問題は起きません。代わりに鏡写しの問題があります。リソースの実行中は MSBuild が `Api.dll` を上書きできないため、コマンドラインからの再ビルドには `dotnet build` の前に `aspire resource api stop` が必要です。IDE はこれを代わりにやってくれますが、シェルスクリプトはやってくれません。

**Aspire のプロキシは `aspire stop` より長く生き残り、コンテナを覆い隠すことがあります。** これは上記の数値を集める間に私の1時間を奪いました。`aspire stop --force` の後も、`dcp` プロセスが固定のホストポートにバインドされたままでした。

```
PID=70448 Name=dcp Addr=127.0.0.1
PID=70448 Name=dcp Addr=::1
```

その後 Docker が同じポートを `::` にバインドし、どちらのコマンドも成功を報告し、`localhost:8080` へのすべてのリクエストにはコンテナではなく取り残された Aspire のプロキシが応答していました。エラーは何も出ません。`docker compose ps` はコンテナが健全でポートもマッピング済みだと表示し、イメージには実際に新しいコードが入っていて、それでもアプリケーションは前のビルドの応答を返し続けます。そもそもコンテナと会話していないからです。私はしばらく Docker のレイヤーキャッシュを疑ってから、実際にポートを所有しているのが誰かを確認しました。

```bash
Get-NetTCPConnection -LocalPort 8080 -State Listen
```

これが問題になるのは `WithHttpEndpoint(port: ...)` でホストポートを固定したときだけですが、compose ファイルを移植するときにやるのはまさにそれです。Aspire の既定である動的ポートなら衝突しません。

## 両方を使う

この選択は後戻りできないものではありません。AppHost のモデルから compose ファイルを生成できるからです。

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6
builder.AddDockerComposeEnvironment("compose")
       .WithDashboard(d => d.WithHostPort(8080));
```

```bash
aspire publish
```

これで `docker-compose.yaml` と、パラメーターが未記入の `.env` が出力され、モデル内のすべてのリソースが追加のオプトインなしに Compose のサービスになります。個別のサービス (コンテナ名、ラベル、再起動ポリシー) をカスタマイズするのが `PublishAsDockerComposeService`、書き出す前に文書全体を編集するのが `ConfigureComposeFile` です。したがって妥当な着地点は、内側のループには Aspire、YAML ファイルを必要とする環境には生成された Compose、そして信頼できる情報源は1つ、という形になります。AppHost 自体は決して出荷されない点に注意してください。これは [`dotnet publish /t:PublishContainer` でコンテナイメージを発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) が、ローカルでの実行方法とは別の関心事であるのと同じです。

## 結論

サービスを自分でビルドする .NET のソリューションにとって、より優れたローカル開発環境は Aspire です。その理由は速度では断じてありません。私が取ったすべての計測で Compose が勝ちました。理由は、コードがデバッグ可能なプロセスとして動くこと、そして本来なら YAML で手作業で維持し、いずれ食い違っていく接続文字列、ポート、OpenTelemetry の構成を AppHost が書いてくれることです。起動の数秒は、コンテナのビルドが古いままなのはなぜかとか、デバッガーがアタッチしないのはなぜかを午後いっぱい調べる時間に比べれば安いものです。

そのファイルに第二の役割があるなら Docker Compose に留まってください。CI、ステージング、runbook がその YAML に依存しているなら、公正な比較は "Aspire 対 Compose" ではなく "Aspire と生成された Compose の組み合わせ 対 Compose 単独" です。そしてチームが小さく、スタックが自分で書いていない5つのイメージなのであれば、後者は2026年においても十分によい答えのままです。

## 関連記事

- [既存の ASP.NET Core ソリューションを作り直さずに Aspire を追加する方法](/ja/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/)
- [.NET Aspire とは何か](/ja/2023/11/what-is-net-aspire/)
- [.NET 11 と無料のバックエンドで OpenTelemetry を使う方法](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [ASP.NET Core の統合テストにおける WebApplicationFactory と Testcontainers の比較](/ja/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/)
- [dotnet publish /t:PublishContainer で .NET 11 アプリをコンテナイメージとして発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## 参考資料

- [Migrate from Docker Compose to Aspire](https://aspire.dev/app-host/migrate-from-docker-compose/)、公式の概念ごとの対応表
- [Deploy Aspire apps with Docker Compose to any host](https://aspire.dev/deployment/docker-compose/)
- [Aspire Docker integration for containerized resources](https://aspire.dev/integrations/compute/docker/)
- [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/)、Postgres と RabbitMQ の既定イメージの変更を含む
- [Aspire service discovery fundamentals](https://aspire.dev/fundamentals/service-discovery/)
- [Compose Develop Specification](https://docs.docker.com/reference/compose-file/develop/)、`watch` について
- [microsoft/aspire releases](https://github.com/microsoft/aspire/releases)
