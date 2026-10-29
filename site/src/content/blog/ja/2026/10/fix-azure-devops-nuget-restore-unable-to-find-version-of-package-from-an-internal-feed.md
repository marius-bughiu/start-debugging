---
title: "修正: Azure DevOps の NuGet restore が内部フィードで \"Unable to find version 'x.y.z' of package\" により失敗する"
description: "バージョンは存在するのに、パイプラインからは見えません。ビルド ID のフィードロール、URL 内のフィードビュー、タスクが使う nuget.config、パッケージソースマッピング、30 分間の HTTP キャッシュを確認しましょう。"
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "nuget"
  - "azure-devops"
  - "dotnet"
  - "dotnet-10"
  - "ci-cd"
lang: "ja"
translationOf: "2026/10/fix-azure-devops-nuget-restore-unable-to-find-version-of-package-from-an-internal-feed"
translatedBy: "claude"
translationDate: 2026-10-29
---

修正方法: Azure Artifacts のフィードにパッケージがあるのに、パイプラインの restore がバージョンを見つけられないと言う場合、ビルドが想定しているフィードに問い合わせていないか、そのバージョンを見られない ID で問い合わせているかのどちらかであることがほとんどです。次の順に確認してください。パイプラインのビルド ID に、フィードの **Feed and Upstream Reader (Collaborator)** ロールがありますか。(単なる **Feed Reader** では、NuGet.org などのアップストリームソースにあってまだフィードに保存されていないバージョンを取得できません。) フィード URL が、そのバージョンが昇格されたことのない `@Release` のようなビューを指していませんか。restore タスクはリポジトリの `nuget.config` を使っていますか、それとも生成された設定ファイルですか。`packageSourceMapping` がそのパッケージ ID を別のソースへ振り分けていませんか。最後に、セルフホストエージェントが NuGet の 30 分間の HTTP キャッシュから古いバージョン一覧を返していませんか。

以下の内容はすべて、.NET 10 SDK (10.0.302、NuGet 7.6.0) と、2026 年 10 月時点の最新の Azure DevOps Services タスク (`NuGetAuthenticate@1`、`DotNetCoreCLI@2`、`NuGetCommand@2`) で検証しています。エラーは SDK のバージョンではなく NuGet のリゾルバーとフィードの権限モデルから発生するため、同じ原因は .NET 8、9、.NET 11 プレビューにも当てはまります。

エラーは、restore を実行するクライアントによって 2 つの形で現れます。`packages.config` プロジェクトに対する `nuget.exe restore` は、古い形式のメッセージを出力します。

```text
// nuget.exe 6.x/7.x, packages.config restore
Unable to find version '1.5.0' of package 'Contoso.Core'.
  https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json: Package 'Contoso.Core.1.5.0' is not found on source 'https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json'.
```

`dotnet restore`、`msbuild -t:restore`、PackageReference プロジェクトに対する `nuget.exe` は、代わりに `NU1102` を出力します。こちらは各ソースが実際に何を返したかが分かるため、はるかに役立ちます。

```text
// dotnet restore, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

2 行目をよく読んでください。"Found 1 version(s)" は、認証が成功し、パッケージ ID が見つかったことを意味します。フィードが、この呼び出し元に `1.5.0` を返さなかっただけです。つまり問題は"この ID が、この URL を通して、どのバージョンを見られるか"に絞られ、まさに以下の原因がそれを左右します。

## ブラウザーでは見えるのにパイプラインではバージョンが見えない理由

Azure DevOps の Web UI でフィードを開くとき、あなたは自分自身 (多くの場合 Feed Owner) として、既定の `@Local` ビューを通して、すべてのアップストリームソースが有効な状態で見ています。一方パイプラインは、別のプリンシパルとして、場合によっては別の URL から、自分では書いていないかもしれない `nuget.config` を使ってフィードを見ています。次のどれもがバージョンを隠す原因になります。

1. **アップストリームのバージョンには、保存できるロールが必要です。** Azure Artifacts は、最初のリクエスト時に自分のフィードへコピーを保存することで、アップストリーム (NuGet.org や別のフィード) のパッケージを提供します。[フィード権限の表](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions)によると、"Save packages from upstream sources" には **Feed and Upstream Reader (Collaborator)** 以上が必要です。**Feed Reader** しか持たないビルド ID は、すでに保存済みのバージョンは restore できますが、新しいバージョンは restore できません。先週ノート PC で `1.5.0` が問題なく restore できたのは、あなたが Collaborator であり、その restore で保存されたからです。まだ誰も restore していない次のバージョンは CI で失敗します。
2. **ビルド ID の取り違え。** パイプラインは `Project Collection Build Service (<org>)` または `<Project> Build Service (<org>)` のどちらかとして実行されます。どちらになるかは "Limit job authorization scope to current project" の設定次第です。もう一方にロールを付与しても何も変わりません。
3. **ビュー URL。** `.../_packaging/contoso-internal@Release/nuget/v3/index.json` は、`@Release` に昇格されたバージョンだけを公開します。公開したばかりの `1.5.0` は、誰かが昇格するまで `@Local` にあります。
4. **タスクが `nuget.config` を無視している。** `feedsToUse: 'select'` を指定した `DotNetCoreCLI@2` と `NuGetCommand@2` は、`vstsFeed` で選んだフィードだけ (`includeNuGetOrg` が true なら NuGet.org も) を含む一時的な設定ファイルを生成します。
5. **パッケージソースマッピング** が `Contoso.*` をあるソースへ振り分けていて、必要なバージョンが別のソースにある場合です。この場合 NuGet は、もう一方のソースのバージョンは "were not considered" (考慮されなかった) と報告します。
6. **古い HTTP キャッシュ。** セルフホストエージェントでは、NuGet はパッケージのバージョン一覧のキャッシュを最大 30 分間再利用するため、5 分前に公開したバージョンは次の実行から見えません。
7. **アップストリームの遅延、または外部バージョンのブロック。** NuGet.org のパッケージはアップストリーム経由で表示されるまでに 3 ～ 6 時間かかることがあり、社内でも公開しているパッケージ ID では外部バージョンがブロックされている場合があります。

## 最小再現: ローカルフォルダーフィードで同じ NU1102 を出す

ソースが求めたより少ないバージョンしか返さないとき NuGet がどうなるかを見るのに、Azure DevOps は必要ありません。この再現手順では、呼び出し元に `1.4.0` しか "見せない" ソースを使って、原因 1 と 3 をローカルでシミュレートします。

```bash
# .NET SDK 10.0.302, macOS/Linux shell
mkdir -p feed lib app
cd lib && dotnet new classlib -n Contoso.Core -o . -f net10.0
dotnet pack -c Release -p:Version=1.4.0 -o ../feed
cd ../app && dotnet new console -f net10.0
dotnet add package Contoso.Core --version 1.5.0 --no-restore
```

```xml
<!-- app/nuget.config, NuGet 7.6 -->
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="contoso-internal" value="../feed" />
  </packageSources>
</configuration>
```

```text
// dotnet restore output, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

これは、ビルド ID がアップストリームから `1.5.0` を保存できない場合や、URL が `1.4.0` しか持たないビューを指している場合に Azure Artifacts から得られる出力と、形がまったく同じです。restore が壊れているわけではありません。ソースが返した内容を忠実に報告しているだけです。

## 修正 1: 適切なビルド ID に Collaborator ロールを付与する

開発者は通常 Collaborator 以上であり、古いフィードのビルド ID はたいてい Reader にすぎないため、"自分のマシンでは動く"という報告の大半はこれが原因です。

1. パイプラインがどの ID として実行されているかを調べます。**Project settings > Pipelines > Settings** で、**Limit job authorization scope to current project for non-release pipelines** を確認します。オンなら ID は `<Project> Build Service (<org>)` です。オフなら `Project Collection Build Service (<org>)` です。リリースパイプラインには、同じページに専用のトグルがあります。
2. **Artifacts** を開き、フィードを選び、歯車アイコンで **Feed settings** を選択し、**Permissions** を開きます。
3. その ID ("Build Service" で検索します) を、ロール **Feed and Upstream Reader (Collaborator)** で追加します。パイプラインがパッケージの push も行う場合は、ドキュメントの推奨どおり、両方のビルド ID に **Feed Publisher (Contributor)** を付与してください。
4. フィードがパイプラインとは別のプロジェクトにあり、プロジェクトスコープの ID を使っている場合は、[Manage permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions#pipelines-permissions) の末尾の注記にあるとおり、そのもう一方のプロジェクトでも、その ID に少なくとも **Edit project-level information** を付与する必要があります。

Azure DevOps Services では、新しいフィードは最初から両方のビルド ID に Collaborator ロールを付与します。壊れるのは、この既定が導入される前に作成されたフィード、Azure DevOps Server 2022 で作成されたフィード (コレクション ID にのみ付与されます)、そして誰かが権限を "厳格化" したフィードです。

次に、パイプラインがそもそも認証できていることを確認します。.NET CLI では `NuGetAuthenticate@1` が公式にサポートされた方法であり、Ubuntu 24.04 以降のホステッドイメージでは `nuget.exe` がサポートされなくなったため必須です。

```yaml
# Azure Pipelines YAML, .NET SDK 10.0.302, NuGetAuthenticate@1
steps:
- task: UseDotNet@2
  inputs:
    packageType: sdk
    version: '10.0.x'

- task: NuGetAuthenticate@1

- script: dotnet restore MySolution.sln --configfile nuget.config
  displayName: Restore
```

`NuGetAuthenticate@1` は Azure Artifacts の資格情報プロバイダーをインストールし、同じ組織内のすべての Azure Artifacts フィードに対してジョブのアクセストークンを渡します。別の組織のフィードについては、**Packaging > Read** の PAT を作成し、NuGet サービス接続でラップして `nuGetServiceConnections` 経由で渡します。方法は [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore) に記載されています。

## 修正 2: バージョンが実際に含まれているビューを指す

`nuget.config` のフィード URL を確認してください。フィード部分の `@` より後ろはビューです。

```xml
<!-- nuget.config, NuGet 7.6: the @Release view only sees promoted versions -->
<add key="contoso-internal"
     value="https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal@Release/nuget/v3/index.json" />
```

すべてのフィードには `@Local`、`@Prerelease`、`@Release` が最初から用意されています。`@Local` には、フィードに公開されたものとアップストリームから保存されたものがすべて含まれます。`@Prerelease` と `@Release` には、Feed Publisher が明示的に昇格したものだけが含まれます。バージョンを昇格する (パッケージを開き、**Promote** を選び、ビューを選びます) か、生成元のパイプラインの最後のステップで昇格させてください。利用側のビルドで未昇格のバージョンも見えるようにしたい場合は、`@Release` サフィックスを外して、フィードの既定のビューを使うようにします。

必要なバージョンがフィード間のアップストリーム経由で来る場合も同じです。アップストリームの定義は相手フィードのビューを指定しているため、そこで昇格されていないバージョンは、あなたのフィード越しにも見えません。

## 修正 3: タスクに nuget.config を置き換えさせない

次の YAML は無害に見えますが、リポジトリの `nuget.config` を捨ててしまいます。

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2: generates a temporary nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: select
    vstsFeed: 'contoso-internal'
    includeNuGetOrg: false
```

`feedsToUse: select` では、タスクは `vstsFeed` だけ (`includeNuGetOrg: true` なら NuGet.org も) を含む一時的な設定ファイルを書き出します。`nuget.config` に 2 つのフィードが書かれている場合や、プロジェクトセグメント付きのプロジェクトスコープのフィード URL を使っている場合、`packageSourceMapping` を含んでいる場合でも、この restore ではそのどれも適用されません。代わりに自分のファイルを使うようタスクに指示します。

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2 with the repo's nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: config
    nugetConfigPath: 'nuget.config'
```

あるいは restore タスクをまったく使わず、修正 1 のように `NuGetAuthenticate@1` の後で `dotnet restore --configfile nuget.config` を実行する方法もあります。CI が実行する内容が、開発者がローカルで実行する内容と完全に一致するという利点があります。

このファイルを編集するついでに、アップストリームフィードに関する Microsoft 自身の助言に従ってください。`<packageSources>` を `<clear />` で始め、アップストリームを有効にした Azure Artifacts フィードをちょうど 1 つだけ列挙します。NuGet はすべてのソースに並列で問い合わせて最初の応答を採用するため、ソースが 2 つあると restore の結果が不確定になります。アップストリーム付きの単一フィードは決まった順序で検索します。フィードに公開されたパッケージ、アップストリームから保存されたパッケージ、そして構成された順の各アップストリームです。

## 修正 4: パッケージソースマッピングを確認する

リポジトリで[パッケージソースマッピング](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping)を使っている場合、エラーが直接それを教えてくれます。

```text
// dotnet restore output, .NET SDK 10.0.302, with packageSourceMapping
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
error NU1102:   - Versions from contoso-release were not considered
```

"Were not considered" は、そのバージョンは `contoso-release` にあるかもしれないが、`Contoso.Core` をそこへ振り分けるマッピングパターンがないことを意味します。各パッケージ ID は、パターンが一致するソースに対してのみ解決され、最も具体的なパターンが優先されます。マッピングを修正します。

```xml
<!-- nuget.config, NuGet 7.6 -->
<packageSourceMapping>
  <packageSource key="contoso-internal">
    <package pattern="Contoso.*" />
    <package pattern="*" />
  </packageSource>
</packageSourceMapping>
```

アップストリームを有効にしたフィードが 1 つだけなら、最も簡単で正しいマッピングは、`*` をそのフィードに割り当てることです。マッピングが意味を持つのは、本当に 2 つのソースを維持する場合だけで、その場合は社内のすべてのプレフィックスを列挙する必要があります。

## 修正 5: セルフホストエージェントで HTTP キャッシュを回避する

ホステッドエージェントは空のキャッシュで始まるため、この問題が起きるのはセルフホストエージェントと開発者のマシンだけです。NuGet の [HTTP キャッシュ](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders#http-cache)は各ソースが返したバージョン一覧を保存し、30 分未満のエントリは再利用されます。`1.5.0` を公開して 3 分後に同じエージェントで利用側のビルドを起動すると、restore は `1.4.0` で終わるキャッシュ済みの一覧をそのまま参照します。

```bash
# .NET SDK 10.0.302
dotnet restore --no-http-cache
# or, for packages.config projects with nuget.exe
nuget restore MySolution.sln -NoHttpCache
# or clear it once
dotnet nuget locals http-cache --clear
```

`--no-http-cache` は、公開直後の社内パッケージを restore するステップであれば、CI で付けたままにしても十分に低コストです。共有エージェントで `dotnet nuget locals all --clear` を使うのは避けてください。`global-packages` を消すと、そのマシン上の他のすべてのパイプラインがすべてを再ダウンロードすることになります。

## 修正 6: アップストリームの遅延を待つか、外部バージョンを許可する

NuGet.org 由来のパッケージでは、フィード側の 2 つの挙動が同じ "nearest version" の症状を引き起こします。

- **伝播の遅延。** [アップストリームソースのドキュメント](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources)には、NuGet.org に push してからアップストリーム経由でそのバージョンが利用可能になるまで、通常 3 ～ 6 時間の遅延があると記載されています。Azure Artifacts フィード間では通常数分です。今朝リリースされた依存関係が失敗し、先週のバージョンなら restore できる場合は、待つか、数時間のあいだ前のバージョンに固定してください。
- **外部バージョンのブロック。** 公開パッケージにも存在するパッケージ ID を社内で公開している場合、Azure Artifacts は依存関係混乱攻撃から保護するために、その ID の新しい公開バージョンの保存をブロックすることがあります。Feed Owner は、パッケージページの **Allow externally-sourced versions** でパッケージごとに許可できます。または [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior) に記載されている `versionsFromExternalUpstreams: AllowExternalVersions` の REST 呼び出しでも許可できます。この変更が反映されるまで最大 3 時間かかります。

あわせて **Feed settings > Upstream sources** で同期ステータスの失敗がないか確認してください。壊れたアップストリームがあると、そのプロトコルのすべてのパッケージでメタデータの更新が止まるため、正常なアップストリームからも新しいバージョンが現れなくなります。

## このエラーに似ているが別物のケース

**`NU1101: Unable to find package Contoso.Core. No packages exist with this id in source(s)`。** これは別の状況で、ID がまったく見つからなかったことを示します。通常は、ソースが間違っているか、フィードがプロジェクトスコープなのに URL にプロジェクトセグメント (`https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/nuget/v3/index.json`) がないか、パッケージソースマッピングがその ID に対してすべてのソースを除外しているかのいずれかです。

**`NU1301: Unable to load the service index for source` や `401 Unauthorized`。** バージョン解決が始まる前に認証が失敗しています。`NuGetAuthenticate@1` を追加し、リポジトリの `nuget.config` に、期限切れの PAT を含む `<packageSourceCredentials>` が直書きされていないか確認してください。これらは資格情報プロバイダーより優先されます。

**`403 Forbidden ... lacks permission to complete this action`。** ID はフィードに到達しましたが、そのフィードに対するロールをまったく持っていません。修正は修正 1 と同じで、加えてジョブの承認スコープも確認します。

**あるパイプラインでは restore できるのに別のパイプラインではできないバージョン。** パイプラインごとに異なる ID で実行されることがあります。クラシックリリースパイプラインには独自のスコープトグルがあり、別のプロジェクトからトリガーされた YAML パイプラインは、そのプロジェクトのビルドサービスとして実行されます。

**中央パッケージ管理のバージョン。** `Directory.Packages.props` を使っている場合、エラーに表示されるバージョンは `.csproj` ではなく中央ファイルから来ているため、プロジェクトファイルを "修正" しても何も変わりません。移行の途中であれば、[ソリューションを中央パッケージ管理へ移行する](/ja/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)方法の解説に、各バージョンがどこから解決されるかが載っています。

**SDK のアップグレード後に消えたパッケージ。** 推移的なパッケージが解決に失敗したのではなく消えた場合は、[.NET 10 の NuGet パッケージ プルーニング](/ja/2026/05/nuget-package-pruning-default-net-10/)によって削除された可能性があります。これは想定された動作で、フィードの問題ではありません。

**公開側の問題。** バージョンが本当にフィードにない場合は、生成元の push が失敗したか拒否されています。MinVer によるバージョニングと、[複数の NuGet パッケージを個別にリリースする](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/)ための trusted publishing の設定を使うと、各タグがどのバージョンを生成したかを簡単に確認できます。push もブロックする NuGet.org 側のセキュリティ制御については、[NuGet アカウントで固めておくべき設定](/ja/2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10/)を参照してください。

## 5 分で原因を特定するチェックリスト

1. `NU1102` の出力全体を読みます。"Found N version(s)" は、認証は機能していて問題はバージョンの可視性にあることを意味します。"Were not considered" は、パッケージソースマッピングが原因であることを意味します。
2. フィード URL は、ローカルの `nuget.config` ではなく restore のログからコピーします。タスクが一時的な設定ファイルを生成した場合、ログにそのパスが表示されるので、`feedsToUse: config` に切り替えます。
3. その URL に `@` がないか確認します。ビューがある場合は、そのビューにバージョンが昇格されているかを確認します。
4. フィードのパッケージページでそのバージョンを探します。そこになく、NuGet.org やアップストリームフィードにはある場合、それは一度も保存されていません。ビルド ID に Collaborator ロールを付与するか、一度 Collaborator として restore して保存します。
5. ジョブの承認スコープの設定から、どのビルド ID がジョブを実行しているかを確認し、その ID そのものをフィードの Permissions ページで確認します。
6. セルフホストエージェントでは、`--no-http-cache` を付けて再実行します。
7. 今日 NuGet.org でリリースされたパッケージなら、アップストリームのステータスとパッケージの外部バージョン設定を確認してから、待ちます。

10 回のうち 9 回は、手順 4 か 5 が答えです。フィードが嘘をついているわけでも、NuGet が壊れているわけでもありません。パイプラインは、あなたとは別の読み手だというだけです。

## 参考資料

- [Manage permissions - Azure Artifacts](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions) (フィードロール、ビルド ID 名、プロジェクト間の注記)
- [What are upstream sources?](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) (検索順序、単一フィードの助言、3 ～ 6 時間の遅延)
- [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior) (Allow external versions)
- [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore) (`NuGetAuthenticate@1`、Ubuntu 24.04 の注記、組織をまたぐフィード)
- [Feed views](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/views)
- [NuGet Error NU1102](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1102)
- [Package Source Mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping)
- [Managing the global packages, cache, and temp folders](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders) (30 分間の HTTP キャッシュ)
- [NuGet.Client Strings.resx](https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.PackageManagement/Strings.resx) (`UnknownPackageSpecificVersion` と `PackageNotFoundOnSource` のメッセージ)
