---
title: "dotnet publish /t:PublishContainer で .NET 11 アプリをコンテナーイメージとして発行する方法"
description: "Dockerfile なしで .NET 11 アプリからコンテナーイメージをビルドする完全ガイドです。PublishContainer ターゲット、ContainerRepository と ContainerImageTags、ContainerBaseImage と ContainerFamily によるベースイメージの選択、レジストリへのプッシュと認証の解決順序、マルチアーキテクチャの OCI イメージインデックス、既定の非 root ユーザー、entrypoint の制御、スキャナー向けの tarball 出力、そして今も Dockerfile が必要になるケースを扱います。"
pubDate: 2026-07-27
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "containers"
  - "docker"
  - "devops"
  - "msbuild"
lang: "ja"
translationOf: "2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer"
translatedBy: "claude"
translationDate: 2026-07-27
---

Dockerfile を書かずに .NET 11 アプリをコンテナーイメージにするには、プロジェクトのディレクトリで `dotnet publish --os linux --arch x64 /t:PublishContainer` を実行します。SDK が適切な Microsoft のベースイメージを取得し、その上に発行の出力を重ね、結果をローカルの Docker または Podman のデーモンにプッシュします。実際のレジストリへ送るなら `-p ContainerRegistry=ghcr.io` を、デーモンにいっさい触れずに tarball を得るなら `-p ContainerArchiveOutputPath=./images/app.tar.gz` を追加してください。Dockerfile が表現するもの (ベースイメージ、タグ、ポート、環境変数、ラベル、ユーザー、entrypoint) はすべて MSBuild のプロパティまたは item です。この記事は .NET 11 (執筆時点では preview 6、正式リリースは 2026 年 11 月) と C# 14、SDK 11.0.1xx を対象にしています。ほとんどの内容は .NET 8、9、10 の SDK でもそのまま動作し、重要な最低バージョンはその都度示します。

## SDK が Dockerfile の代わりに行うこと

多くの人が最初に持つイメージは、有益な形で間違っています。`PublishContainer` は `docker build` のラッパーではありません。裏で Dockerfile が生成されることもなく、イメージの作成に Docker はいっさい関与しません。

実際に起きているのは、SDK に同梱される `Microsoft.NET.Build.Containers` のターゲットが、レジストリの HTTP API と直接やり取りするということです。

1. アプリは通常どおり `bin/Release/net11.0/<rid>/publish/` に発行されます。
2. SDK がベースイメージ (既定では `mcr.microsoft.com/dotnet/*` のいずれかのリポジトリ) を解決し、そのマニフェストと構成を MCR から取得します。不要なレイヤーの blob はダウンロードしません。
3. 発行フォルダーが 1 つの新しい tar レイヤーにパックされます。
4. 新しいイメージ構成とマニフェストが組み立てられます。ベースのレイヤーに自分のレイヤーを加え、さらに entrypoint、作業ディレクトリ、公開ポート、環境変数、ラベル、ユーザーが設定されます。
5. 結果がどこかにプッシュされます。既定ではローカルのデーモン、`ContainerRegistry` を設定した場合はリモートのレジストリ、`ContainerArchiveOutputPath` を設定した場合はディスク上の `tar.gz` です。

ここから 2 つの帰結がすぐに導かれます。1 つ目は、イメージを*ビルドする*ためにコンテナーランタイムは不要で、ローカルで*実行する*ときにだけ必要だということです。おかげで Docker ソケットのない CI エージェントでも実用になります。2 つ目は、ビルド中にコンテナーが実行されないため `RUN` ステップが存在しないことです。イメージに `apt-get install` が必要なら、それは独自のベースイメージに焼き込み、`ContainerBaseImage` でそれを指します。

`/t:PublishContainer` は `dotnet publish` のオプションではなく MSBuild のターゲットであり、だからこそ MSBuild の構文になっています。古い `-p PublishProfile=DefaultContainer` の形式も引き続き動作し、同じことを行います。`dotnet build` と `dotnet publish` の違いが曖昧なら、[dotnet build と dotnet publish の違い](/ja/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)に 5 分使う価値があります。ここでの内容はすべて発行の出力に依存しているからです。

## .NET 11 アプリをコンテナーイメージとして発行する手順

1. .NET 11 SDK が入っていることを確認します (`dotnet --info`)。コンテナーの発行は .NET 7 SDK から使えますが、ここで説明する既定値は .NET 8 SDK 以降のものです。
2. アセンブリ名が正当なイメージ名でない場合は、プロジェクトファイルで `ContainerRepository` を設定します (大文字が原因になることがほとんどです)。
3. `dotnet publish --os linux --arch x64 /t:PublishContainer` を実行してイメージをビルドし、ローカルのデーモンに読み込みます。
4. `docker images` で確認し、実行します。`docker run --rm -p 8080:8080 my-app:latest` です。
5. ローカルでイメージが正しくなったら、`docker login <registry>` で認証したうえで `-p ContainerRegistry=<registry>` を追加します。
6. 恒久的に使いたい設定は `.csproj` に移し、CI とローカル実行の内容を一致させます。

これで一巡です。この記事の残りは、各つまみが何をするのか、どこに鋭い角があるのかという話です。

## 名前の構成: レジストリ、リポジトリ、タグ

SDK が生成するイメージ名は、完全修飾のイメージ参照の各部分に対応する個別のプロパティから組み立てられます。

```text
REGISTRY[:PORT]/REPOSITORY[:TAG]
```

- `ContainerRegistry` は既定でローカルのデーモンを指します。`ghcr.io`、`myorg.azurecr.io`、`docker.io`、`quay.io`、あるいはプライベートな `registry.mycorp.com:5000` を設定します。
- `ContainerRepository` は既定でプロジェクトの `AssemblyName` になります。イメージ名は小文字の英数字にピリオド、アンダースコア、ハイフン、スラッシュを加えたもので構成し、先頭は英字か数字でなければなりません。`DotNet.ContainerImage` というアセンブリ名は正当なリポジトリ名ではなく、だから Microsoft のチュートリアルはこのプロパティを明示的に設定しています。
- `ContainerImageTag` は .NET 8 SDK 以降で既定が `latest` です。それ以前の既定はプロジェクトの `Version` でした。

```xml
<!-- .csproj, .NET 11 SDK 11.0.1xx -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <ContainerRegistry>ghcr.io</ContainerRegistry>
  <ContainerRepository>marius-bughiu/orders-api</ContainerRepository>
  <ContainerImageTags>1.4.2;latest</ContainerImageTags>
</PropertyGroup>
```

`ContainerImageTags` (複数形、セミコロン区切り) はタグごとに 1 つのイメージを生成します。これは「固定バージョンと動く latest」という一般的なリリースの型です。タグは 127 文字までで、先頭は英数字かアンダースコアである必要があります。

複数形はコマンドラインで本物の罠になります。セミコロンは MSBuild のリスト区切り文字であり、PowerShell も Bash もそれを解釈したがるからです。エスケープはシェルによって異なります。

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  /p:ContainerImageTags='"1.4.2;latest"'
```

```powershell
dotnet publish --os linux --arch x64 /t:PublishContainer /p:ContainerImageTags=`"1.4.2`;latest`"
```

CI スクリプトでこの戦いをしたくないなら、代わりに環境変数 `ContainerImageTags` を設定してください。MSBuild は環境変数をプロパティとして読み、シェルは解釈したくなるセミコロンを目にすることがありません。

なお、Docker Hub へのプッシュにはリポジトリ名にユーザー名が必要です (`myuser/orders-api`)。裸のイメージ名だけでは足りません。

## FROM 行なしでベースイメージを選ぶ

既定では、SDK はプロジェクトの形からベースイメージを推論します。

- ASP.NET Core のプロジェクトには `mcr.microsoft.com/dotnet/aspnet` が使われます。
- self-contained のプロジェクトには `mcr.microsoft.com/dotnet/runtime-deps` が使われます。ランタイムが発行出力の中に入っているためです。
- それ以外には `mcr.microsoft.com/dotnet/runtime` が使われます。

タグは `TargetFramework` の数値部分から決まるため、`net11.0` は `11.0` タグに解決されます。SDK 8.0.200 以降、この推論は発行のしかたにも反応します。`linux-musl-x64` または `linux-musl-arm64` の RID では Alpine 系のバリアントが選ばれ、`PublishAot=true` では `runtime-deps` の chiseled AOT バリアントが選ばれます。

イメージそのものを変えるのではなく Microsoft イメージの*系統*を変えたい場合は `ContainerFamily` を使います。値は推論されたタグの末尾に追加されます。

```xml
<PropertyGroup>
  <ContainerFamily>alpine</ContainerFamily>
</PropertyGroup>
```

これでベースイメージのタグは `11.0-alpine` になります。このフィールドは自由形式で単純に連結されるだけなので、指定したタグが `mcr.microsoft.com/dotnet/aspnet` (または `runtime`) のリポジトリに実際に存在するかを確認してから採用してください。`ContainerBaseImage` を設定した場合、`ContainerFamily` は完全に無視されます。

完全に制御したい場合は、タグを含む完全修飾名を `ContainerBaseImage` に設定します。

```xml
<PropertyGroup>
  <ContainerBaseImage>mcr.microsoft.com/dotnet/aspnet:11.0-alpine</ContainerBaseImage>
</PropertyGroup>
```

これは `RUN` が使えないことへの逃げ道でもあります。必要なネイティブパッケージを入れる Dockerfile でベースイメージを一度だけ作り、それをプッシュして、すべてのサービスからそれを指すようにします。

Windows コンテナーも同じ扱いが必要です。.NET 8 以降、Microsoft のマニフェストリストには Windows のバリアントが含まれなくなったため、Nano Server を狙うならタグを明示する必要があります。たとえば `mcr.microsoft.com/dotnet/aspnet:11.0-nanoserver-ltsc2022` です。

本当に小さいイメージを目指して Native AOT と組み合わせる場合、[Native AOT が実際にどれだけのコストを伴うか](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)で述べたトレードオフはコンテナーの中でもそのまま当てはまります。レイヤーの削減量よりも、リフレクション制限がライブラリ互換性に与える負担のほうが大きくなりがちです。

## レジストリへのプッシュと認証の解決順序

`ContainerRegistry` を設定すると、SDK はローカルのデーモンに読み込む代わりに Docker Registry HTTP API V2 経由でプッシュします。

```bash
# .NET 11 SDK
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerRegistry=ghcr.io \
  -p ContainerRepository=marius-bughiu/orders-api
```

資格情報は Docker 自身の構成を通じて、次の有用性の順で解決されます。

1. `~/.docker/config.json`、または環境変数 `DOCKER_CONFIG` が指すディレクトリ。`auths` セクション (`docker login` が書き込む内容) が直接読まれます。
2. `credHelpers` のエントリ。レジストリを `PATH` 上の `docker-credential-<name>` 実行ファイルに対応付けます。ACR、ECR、Google Artifact Registry が短命なトークンを発行するのはこの仕組みです。
3. `credsStore`、オペレーティングシステムのキーチェーンのヘルパーです。

これらがいずれも利用できない場合、たとえば Docker の構成がマウントされていない SDK コンテナーの中では、最後の手段として 2 つの環境変数があります。

```bash
export DOTNET_CONTAINER_REGISTRY_UNAME='<token>'
export DOTNET_CONTAINER_REGISTRY_PWORD="$GITHUB_TOKEN"
```

これらについて知っておくべきことが 2 つあります。接頭辞は SDK 8.0.400 で `SDK_CONTAINER_*` から `DOTNET_CONTAINER_*` に変わっており、古い記事はいまだに旧名を載せています。そして、これらはベースイメージの取得元 (MCR) と送り先の*両方*のレジストリに適用されるため、両者で異なる資格情報が必要な場合には使えません。`docker login` を優先してください。

社内ネットワークの平文 HTTP レジストリについては、SDK 9.0.1xx 以降がカンマ区切りの許可リストを受け付けます。

```bash
export DOTNET_CONTAINER_INSECURE_REGISTRIES=localhost:5000,registry.mycorp.com
```

**.NET 11 の新機能:** SDK は、レジストリが認証チャレンジで返す bearer トークンの `realm` を、そこへ進む前に検証するようになりました ([dotnet/sdk#54225](https://github.com/dotnet/sdk/pull/54225))。realm は絶対 URI でなければならず、そのレジストリが明示的に非セキュアと指定されていない限り HTTPS でなければならず、ループバック、プライベート、リンクローカル、未指定の IP リテラルに解決されてはなりません。レジストリのホストと認証のホストが異なること自体は引き続き許可されており、これは通常の OCI のパターンです。設定を誤ったレジストリや悪意あるレジストリでこれまで「動いていた」ものが、発行の早い段階で失敗するようになるという意味で破壊的変更です。これまで問題のなかった社内レジストリが .NET 11 で失敗し始めたら、まずこの検証を確認してください。

## マルチアーキテクチャイメージと OCI イメージインデックス

SDK 8.0.405、9.0.102、9.0.2xx 以降、`PublishContainer` は本物のマルチアーキテクチャイメージを生成できます。ルールは、どの RID プロパティを設定するかで決まります。

- 単一の `RuntimeIdentifier` または `ContainerRuntimeIdentifier` を指定した場合は、従来どおり単一アーキテクチャのイメージになります。
- 単一の RID がなく、複数の `RuntimeIdentifiers` または `ContainerRuntimeIdentifiers` が設定されている場合、SDK は RID ごとに 1 回ずつ発行し、その結果を [OCI Image Index](https://specs.opencontainers.org/image-spec/image-index/) にまとめて、すべてのアーキテクチャが 1 つの名前を共有できるようにします。

```xml
<!-- .NET 11, SDK 11.0.1xx -->
<PropertyGroup>
  <RuntimeIdentifiers>linux-x64;linux-arm64</RuntimeIdentifiers>
  <ContainerRuntimeIdentifiers>linux-x64;linux-arm64</ContainerRuntimeIdentifiers>
</PropertyGroup>
```

```bash
# Note: no --arch, and no -r. Passing either collapses it back to one architecture.
dotnet publish --os linux /t:PublishContainer
```

`ContainerRuntimeIdentifiers` は `RuntimeIdentifiers` の部分集合でなければならず、そうでないとビルドパイプラインの一部が分かりにくい形で失敗します。マルチアーキテクチャイメージは `ContainerImageFormat` の値にかかわらず常に OCI 形式で出力されます。Docker v2 のマニフェストスキーマにはイメージインデックスに相当するものがないからです。

運用上の注意が 2 つあります。Blazor WebAssembly のプロジェクトは、RID を並行して発行するとビルドの競合状態に当たることがあります。`ContainerPublishInParallel=false` は所要時間と引き換えにこれを直列化します (SDK 8.0.408、9.0.300、10.0 以降)。また .NET 11 preview 6 では、ローカルのエンジンが Podman の場合のマルチアーキテクチャ対応が追加されました ([dotnet/sdk#54575](https://github.com/dotnet/sdk/pull/54575))。以前は Docker が必要でした。

.NET 10 で追加された `ContainerImageFormat` は、単一アーキテクチャの場合に `Docker` か `OCI` を強制できます。既定はベースイメージから推論され、Microsoft のイメージは今も Docker のマニフェストのメディアタイプを使っています。後続のツールが要求する場合は `OCI` に設定してください。

## ポート、環境変数、ラベル、ユーザー

これらはプロパティではなく item なので、`ItemGroup` に書きます。

```xml
<ItemGroup>
  <ContainerPort Include="8080" Type="tcp" />
  <ContainerEnvironmentVariable Include="ASPNETCORE_FORWARDEDHEADERS_ENABLED" Value="true" />
  <ContainerLabel Include="org.contoso.businessunit" Value="orders" />
</ItemGroup>
```

`ContainerPort` は .NET 8 以降、`ASPNETCORE_URLS`、`ASPNETCORE_HTTP_PORTS`、`ASPNETCORE_HTTPS_PORTS` から推論されます。値はベースイメージか、自分で書いた `ContainerEnvironmentVariable` の item から読まれます。ASP.NET Core のイメージは `ASPNETCORE_HTTP_PORTS=8080` を設定しているため、普通の Web API ならポートの設定はまず不要です。

`ContainerEnvironmentVariable` には計画に織り込むべき実際の制限があります。現状は CLI からは設定できず、プロジェクトファイルからしか設定できません ([dotnet/sdk-container-builds#451](https://github.com/dotnet/sdk-container-builds/issues/451))。したがって環境依存の値はイメージに焼き込むのではなくオーケストレーターの構成に置くべきで、そもそもそれが本来あるべき場所です。

ラベルはほぼ自動で処理されます。SDK は既存の MSBuild プロパティから標準的な OCI アノテーション (`org.opencontainers.image.created`、`.version`、`.title`、`.source`、`.revision`、`.base.name`、`.base.digest` など) を書き込みます。`.source` と `.revision` が付くのは `PublishRepositoryUrl` が `true` で、ビルドに SourceLink が含まれている場合だけです。全体をやめるなら `ContainerGenerateLabels=false`、個別に外すならそれぞれの `ContainerGenerateLabelsImage*` フラグを使います。

ユーザーの既定値は、良い意味で意外に思われるものです。.NET 8 以降を対象にして Microsoft のランタイムイメージを使う場合、コンテナーは Linux では非 root のユーザー `app` (環境変数 `APP_UID` を通じて UID で参照されます)、Windows では `ContainerUser` として動作します。これは正しい既定値であり、そのままにしておくべきです。ただしアプリは任意のパスに書き込めず、1024 未満のポートをバインドできず、root を前提とした権限のファイルを読めません。本当に root が必要なら `ContainerUser=root` があり、SDK は指定したユーザーがイメージに存在するかどうかを検証しません。

`ContainerWorkingDirectory` の既定値は `/app` です。

## entrypoint を制御する

ほとんどのアプリでは生成された apphost のバイナリが entrypoint になり、やることはありません。アプリではなくツールをイメージに実行させたい場合は、`ContainerAppCommand` と `ContainerAppCommandArgs` を使い、呼び出し側が上書きできるべき引数には `ContainerDefaultArgs` を使います。

```xml
<ItemGroup>
  <!-- Semicolons split tokens: this is dotnet ef database update -->
  <ContainerAppCommand Include="dotnet;ef" />
  <ContainerAppCommandArgs Include="database;update" />
</ItemGroup>
```

`ContainerAppCommandInstruction` は、これらがベースイメージの `ENTRYPOINT` とどう組み合わさるかを決め、`Entrypoint`、`DefaultArgs`、`None` のいずれかを取ります。既定は `DefaultArgs` で、これが最も微妙です。`ContainerEntrypoint` の item が存在しないとき、`dotnet` または `/usr/bin/dotnet` にハードコードされたベースイメージの entrypoint をスキップし、完全な制御をこちらに渡します。`ContainerEntrypoint` と `ContainerEntrypointArgs` は .NET 8 の時点で非推奨です。代わりに app command の item を使ってください。

## スキャンパイプライン向けの tarball 出力

セキュリティを重視するパイプラインでは、レジストリに何かが届く前にスキャンしたいことがよくあります。`ContainerArchiveOutputPath` はイメージを `tar.gz` に書き出し、デーモンを必要としません。

```bash
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerArchiveOutputPath=./images/orders-api.tar.gz
```

```bash
docker load -i ./images/orders-api.tar.gz
```

Podman では同じファイルを `podman load -i` で読み込みます。ファイル名ではなくディレクトリを指定した場合、アーカイブ名は `$(ContainerRepository).tar.gz` になります。`ContainerImageTags` のすべてのタグは複数のファイルではなく、この 1 つのアーカイブの中に収まります。

## GitHub Actions への組み込み

Buildx も QEMU も、プロジェクトと同期を保つべき Dockerfile も存在しないため、全体が 3 ステップに収まります。

```yaml
# .github/workflows/publish.yml
- uses: actions/setup-dotnet@v4
  with:
    dotnet-version: '11.0.x'

- name: Log in to GHCR
  run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin

- name: Publish container
  run: >
    dotnet publish src/Orders.Api/Orders.Api.csproj
    --os linux /t:PublishContainer
    -p ContainerRegistry=ghcr.io
    -p ContainerRepository=${{ github.repository_owner }}/orders-api
    -p ContainerImageTag=${{ github.sha }}
```

`docker login` は `~/.docker/config.json` を用意するためだけに使われ、プッシュ自体は SDK が HTTPS 経由で行います。Docker がまったくないランナーでは、このステップを `DOTNET_CONTAINER_REGISTRY_UNAME` と `DOTNET_CONTAINER_REGISTRY_PWORD` のエクスポートに置き換えてください。

## それでも Dockerfile が必要な場合

境界については正直でいましょう。`RUN` ステップが必要なとき、マルチステージビルドが同じファイルで .NET 以外の成果物 (Node のフロントエンド、ネイティブ依存) をコンパイルする必要があるとき、多数のイメージにまたがるキャッシュ効率のためにレイヤー順序を細かく制御したいときは、Dockerfile を選んでください。

それ以外、実務上はほとんどの ASP.NET Core サービスと worker service は、`PublishContainer` のほうが快適です。イメージの構成はビルドの残りと同じファイルにあり、TFM とずれることがなく、`COPY --from=build /app/publish .` の行を書き間違える余地もありません。すでにアプリを [.NET Aspire](/ja/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) 上で動かしているなら、これはデプロイのために AppHost がプロジェクトリソースをコンテナー化するときに使う仕組みでもあります。

コンソールアプリについて最後にバージョンの補足です。.NET 10 SDK 以降では、コンソールプロジェクトは追加の構成なしでコンテナーを発行できます。.NET 9 以前の SDK ではプロジェクトファイルに `<EnableSdkContainerSupport>true</EnableSdkContainerSupport>` が必要で、このプロパティは今でも、SDK が自動的に有効化しないプロジェクトの種類に対して設定するものです。

## 関連記事

- [dotnet build と dotnet publish の違いは何ですか?](/ja/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)：イメージのレイヤーになるフォルダーに実際に何が入るのか。
- [Native AOT とは何で、何を犠牲にするのか?](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)：`PublishAot` で小さいイメージを追う前に。
- [.NET 11 における Native AOT vs ReadyToRun vs JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)：その判断の裏にある起動時間とサイズの数値。
- [既存の ASP.NET Core ソリューションに .NET Aspire を追加する方法](/ja/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/)：同じプロジェクトにローカルのオーケストレーションも必要な場合。
- [trim セーフなコードとは何で、どう書くのか?](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)：trimming はコンテナーイメージを小さくするもう半分だからです。

## 参考リンク

- Microsoft Learn の [Containerize an app with dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/containers/sdk-publish)。
- [Containerize a .NET app reference](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration)、プロパティと item の完全な一覧。
- dotnet/sdk-container-builds リポジトリの [Authenticating to container registries](https://github.com/dotnet/sdk-container-builds/blob/main/docs/RegistryAuthentication.md)。
- [What's new in the SDK and tooling for .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk)、`ContainerImageFormat` とコンソールアプリのサポートについて。
- [.NET SDK in .NET 11 Preview 5 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md)、bearer トークンの realm 検証について。
- [.NET SDK in .NET 11 Preview 6 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md)、Podman でのマルチアーキテクチャ対応について。
