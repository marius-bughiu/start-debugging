---
title: "解決: failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet"
description: "BuildKit がベースイメージのマニフェストを読めていません。タグの存在確認、Docker credential helper の修復、MCR の 2 つのエンドポイント開放、オフラインビルド向けの事前 pull を順に確認します。"
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "buildkit"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/08/fix-failed-to-resolve-source-metadata-for-mcr-microsoft-com-dotnet-aspnet"
translatedBy: "claude"
translationDate: 2026-08-29
---

これは BuildKit が `FROM` 行のイメージマニフェストを読めずに失敗しているもので、Dockerfile の命令が 1 つも実行される前に発生します。原因はほぼ次の 4 つで、優先度順に並べるとこうなります。タグが存在しない (.NET 11 が preview の間、`11.0` は実在するタグではありません)、`~/.docker/config.json` の credential helper が壊れている、プロキシやファイアウォールが `mcr.microsoft.com` または `*.data.mcr.microsoft.com` を遮断している、ローカルに pull したイメージを見られないビルダーでオフラインビルドしている、の 4 つです。まず `docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:10.0` を実行してください。これも失敗するなら、原因は Dockerfile ではありません。

```text
 => ERROR [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0
------
 > [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0:
------
failed to solve: failed to resolve source metadata for
mcr.microsoft.com/dotnet/aspnet:11.0: mcr.microsoft.com/dotnet/aspnet:11.0: not found
```

以下の内容は Docker Engine 29 (BuildKit v0.32.x、Buildx v0.32)、.NET 10 (`10.0`、2025-11-11 リリース)、および 2026 年 8 月時点で Preview 7 に到達し GA が 2026 年 11 月に予定されている .NET 11 preview で検証しています。同じ仕組みは Engine 27 と 28、および Podman の BuildKit 互換フロントエンドにもそのまま当てはまります。バージョン間で変わるのは末尾の句の正確な文言だけです。

## BuildKit が "resolve source metadata" と言うとき何をしているのか

BuildKit は、従来のビルダーのように Dockerfile を上から下へ実行するわけではありません。まず依存グラフを構築し、そのためにすべての `FROM` 参照が実際に何を指すのかを知る必要があります。つまり、何かを計画する前に参照をコンテンツダイジェストに固定するため、ベースイメージごと・ビルドごとに `HEAD https://mcr.microsoft.com/v2/dotnet/aspnet/manifests/<tag>` リクエストが 1 回飛びます。このリクエストがビルド出力に見える "load metadata" ステップであり、あなたが受け取ったメッセージはそのステップの失敗です。

ここから 3 つの帰結が導かれ、このエラーをめぐる混乱のほとんどはこれで説明できます。

- **レイヤーがすべてキャッシュ済みでも発生します。** キャッシュされたレイヤーは「このタグは今も同じダイジェストを指しているか」という問いに答えません。だから BuildKit は必ず問い合わせます。1 時間前にまったく同じイメージをビルドしたマシンでも、オフラインビルドが失敗するのはこのためです。
- **`RUN`、`COPY`、`WORKDIR` より前に発生します。** ビルド環境に影響するビルド引数はここでは一切役に立ちません。ビルド環境がまだ何も起動していないからです。特に `--build-arg HTTP_PROXY=...` はここでは何もしません。この引数は `RUN` ステップに注入されるものであり、BuildKit デーモン自身のレジストリクライアントを設定するものではありません。
- **最後のコロンの後ろの句が本当のエラーです。** `not found` はタグが存在しないという意味です。`dial tcp ...: i/o timeout` はネットワークです。`error getting credentials` は Docker の設定です。まずこの句を読み、下の該当セクションへ直接進んでください。

メッセージの残りはすべて BuildKit のラッパーです。失敗している動作はいつも同じです。

## 最小の再現

ビルド用イメージとランタイム用イメージの 2 ステージ構成で、.NET のコンテナーテンプレートが生成する形そのものです。

```dockerfile
# Docker Engine 29, BuildKit v0.32. Fails at "load metadata".
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`docker build .` は上記のエラーで即座に失敗し、`dotnet publish` には決して到達しません。アプリケーションコードがまったく関与していない点に注目してください。この Dockerfile だけを置いた空のディレクトリで再現します。プロジェクトが原因ではないと証明する最速の方法です。

## 解決 1: タグが本当に存在するか確認する

現時点で最も多い原因であり、理由は .NET 11 です。Microsoft はリリースが GA に到達するまで、メジャーバージョンの浮動タグを公開しません。preview 期間中のタグは `11.0-preview` と固定版の `11.0.0-preview.7`、それに `11.0-preview-resolute` や `11.0-preview-alpine` のような OS 修飾つきバリアントです。`11.0` は存在しません。このタグが登場するのは 2026 年 11 月で、それより前ではありません。したがって .NET 10 プロジェクトからコピーして手作業でバージョンを上げた Dockerfile は、一度も存在したことのない名前で失敗します。

推測せず、レジストリに直接尋ねてください。

```bash
# Works against any registry, prints the manifest list and its platforms.
docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:11.0-preview
```

MCR は匿名でアクセスできる OCI のタグ一覧も提供しており、実際に何が公開されているか確認したいときに便利です。

```bash
curl -s https://mcr.microsoft.com/v2/dotnet/aspnet/tags/list | jq '.tags[] | select(startswith("11.0"))'
```

タグの誤りには、まったく同じメッセージを出すものがあと 2 つあります。1 つ目はリポジトリの改名です。.NET Core 3.1 以前は `mcr.microsoft.com/dotnet/core/aspnet` に置かれており、.NET 5 以降はすべて `mcr.microsoft.com/dotnet/aspnet` にあります。古い Dockerfile を持ち越すと `core/` セグメントが残り、モダンなバージョンではすべて `not found` になります。2 つ目は引退した OS バリアントの選択で、たとえば Debian ベースがすでに次へ進んだ .NET バージョンに対して `bullseye-slim` タグを指定する場合です。どのバリアントが生きているかについては [.NET コンテナーイメージのタグのドキュメント](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md) が権威であり、古い記事を信用するよりベースイメージを変えるたびに読む価値があります。OS バリアントを選ぶ段階なら、[.NET 10 の resolute コンテナータグ](/ja/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) で説明したトレードオフは .NET 11 preview にもそのまま当てはまります。

## 解決 2: Docker credential helper を修復する

末尾の句が次のようになっている場合、レジストリは正常で、壊れているのはローカルの Docker 設定です。

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0:
error getting credentials - err: exit status 1, out: ``
```

Docker CLI は `~/.docker/config.json` を読み、`credsStore` または `credHelpers` のエントリを見つけると、レジストリの資格情報を取得するために `docker-credential-<name>` というバイナリを起動します。そのバイナリが `PATH` になかったり、キーチェーンに到達できなかったりすると、CLI は MCR に接続する前に中断します。典型的なきっかけは、WSL2 ディストリビューション、CI コンテナー、`docker-credential-desktop` が存在しないリモート SSH セッションと共有された設定ファイルにある `"credsStore": "desktop"` です。

MCR はパブリックイメージを匿名で配信するので、そもそも資格情報は不要です。エントリを削除してください。

```json
{
  "auths": {},
  "credsStore": ""
}
```

あるいは `credsStore` キーごと削除します。macOS で動く値は `osxkeychain`、Linux では `pass` か `secretservice` です。helper が実際にインストールされている場合は、応答するか確認してください。

```bash
echo '{"ServerURL":"https://index.docker.io/v1/"}' | docker-credential-desktop get
```

関連するバリアントとして、MCR への HEAD リクエストで `401 Unauthorized` が返るケースがあります。これは匿名レジストリに古い資格情報が送られているという意味です。`docker logout mcr.microsoft.com` で消してからビルドし直してください。

## 解決 3: MCR の 2 つのエンドポイントを開け、ビルダーにプロキシを設定する

Microsoft Artifact Registry は処理を 2 つのホスト名に分けており、片方だけを対象にしたファイアウォール規則はランダムに見える形で失敗します。`mcr.microsoft.com` はコンテンツ探索、つまりマニフェストとタグのリクエストを担当します。`*.data.mcr.microsoft.com` はレイヤーの実データを配信する Azure Front Door の CDN です。Microsoft の [クライアント向けファイアウォール規則](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md) はどちらも HTTPS のポート 443 で許可することを求めており、データエンドポイントのリージョンは性能上の理由で変わるため、リージョン固有の規則は避けるよう明確に警告しています。レジストリエンドポイントだけを許可すると、メタデータの解決は成功し、その後の pull で死にます。どちらも許可しなければ、この記事のエラーになります。

最も時間を無駄にしがちなのがプロキシ設定です。使っているビルダードライバーによって挙動が違うからです。

- **デフォルトの `docker` ドライバー** は Docker デーモン内で BuildKit を実行するため、デーモンのプロキシ設定を継承します。Docker Desktop では Settings、Resources、Proxies です。Linux では `/etc/systemd/system/docker.service.d/http-proxy.conf` に systemd の drop-in を置き、`systemctl daemon-reload && systemctl restart docker` を実行します。
- **`docker buildx create` が作る `docker-container` ドライバー** は BuildKit を独立したコンテナーで実行し、何も継承しません。環境変数を明示的に渡す必要があります。

```bash
# Buildx v0.32. env.<key> sets variables inside the BuildKit container.
docker buildx create --name proxied \
  --driver docker-container \
  --driver-opt env.HTTP_PROXY=http://proxy.corp:8080 \
  --driver-opt env.HTTPS_PROXY=http://proxy.corp:8080 \
  --driver-opt env.NO_PROXY=localhost,127.0.0.1 \
  --use
```

プロキシが社内認証局で TLS を終端している場合、末尾の句は `tls: failed to verify certificate: x509: certificate signed by unknown authority` になります。デーモン側の対処は、その CA をホストのトラストストアに入れて Docker を再起動することです。`docker-container` ビルダーの場合は、独自の `buildkitd.toml` 経由でマウントするか、あるいはデフォルトドライバーでビルドするかして、CA をそのコンテナーの中に届ける必要があります。

純粋な DNS の失敗は `dial tcp: lookup mcr.microsoft.com: no such host` として現れ、VPN を切り替えた後の WSL2 でよく起こります。`/etc/docker/daemon.json` に `"dns": ["1.1.1.1", "8.8.8.8"]` と明示的なリゾルバーを設定してデーモンを再起動すれば、たいてい解消します。

## 解決 4: オフラインビルドでは事前に pull し、ビルダードライバーに注意する

メタデータの解決は常に生きたレジストリを必要とするため、レイヤーがディスク上にあってもネットワークから切り離された環境や不安定な回線ではビルドが失敗します。対処は、イメージを単にキャッシュに置くのではなく、ローカルのイメージストアに存在させることです。

```bash
# Run these while you still have connectivity.
docker pull mcr.microsoft.com/dotnet/sdk:10.0
docker pull mcr.microsoft.com/dotnet/aspnet:10.0
```

デフォルトの `docker` ドライバーであれば、BuildKit はデーモンのイメージストアから参照を解決できるようになり、オフラインビルドが通ります。`--pull=false` を付ければ意図が明確になり、BuildKit がリモート参照を優先するのを止められます。

落とし穴は、これがデフォルトドライバーでしか効かない点です。`docker-container` ビルダーは独自のコンテンツストアを持ち、Docker デーモンのイメージを見られません。これは [長年知られ、繰り返し再発見されている挙動](https://github.com/moby/moby/issues/49542) です。マルチプラットフォーム出力のためにカスタムビルダーを作ってからオフラインになった場合、事前 pull は何の役にも立ちません。オフライン作業では `docker buildx use default` で戻すか、ビルダーから到達できるレジストリミラーを立ててください。

同じ区別は CI でも噛みつきます。`docker/setup-buildx-action` を使う GitHub Actions のランナーは既定で `docker-container` ビルダーになるため、ローカルでは `docker pull` ステップの後に通るワークフローでも、ランナー上ではレジストリにアクセスします。

## 解決 5: プラットフォームを合わせる

タグは存在するのに対象プラットフォーム向けのイメージがない場合、同じステップで末尾だけ違う形で失敗します。

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0-nanoserver-ltsc2022:
no match for platform in manifest: not found
```

よくあるのは 2 パターンです。1 つ目は、Linux コンテナーで動作するデーモンから `nanoserver` や `windowsservercore` のような Windows 専用タグを要求した場合です。Docker Desktop を Windows コンテナーに切り替えるか、Linux 用のタグを使ってください。2 つ目は、amd64 しか公開していないタグに対して `--platform linux/arm64` を明示した場合です。.NET のランタイムイメージは amd64、arm64、arm32v7 を公開しているので、Microsoft のイメージよりサードパーティのサイドカーイメージで起きがちです。`docker buildx imagetools inspect` は manifest list のすべてのプラットフォームを表示するので、イメージが壊れていると決めつける前にそこを確認してください。

## 同じに見えて違うもの

`failed to solve: process "/bin/sh -c dotnet restore" did not complete successfully` はまったく別の失敗です。メタデータの解決は成功しビルドが走り始めているので、問題はレジストリではなく NuGet です。同様に、ビルドステージ内の `NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json` は、コンテナーが MCR には到達できるが NuGet には到達できないという意味で、たいていは 1 階層下の同じプロキシの話です。

イメージが pull されて起動するのにコンテナーがすぐ終了する場合は、このエラーはすでに通過してランタイムの領域に入っています。[ICU パッケージが見つからない問題の解決](/ja/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) で扱ったグローバリゼーションのクラッシュが、軽量ベースイメージでは最も多いものです。

最後に、そもそも `FROM` 行と格闘しているなら、Dockerfile が必要かどうかを考え直す価値があります。SDK は OCI イメージを直接生成でき、[`/t:PublishContainer` で .NET 11 アプリを発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) では NuGet 風のロジックでベースイメージを解決するため、BuildKit よりはるかに具体的なメッセージで失敗します。

## 関連記事

- [dotnet publish /t:PublishContainer で .NET 11 アプリをコンテナーイメージとして発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [.NET 10 と Ubuntu 26.04: resolute コンテナータグとアーカイブの Native AOT](/ja/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/)
- [解決: .NET コンテナーで Couldn't find a valid ICU package installed on the system](/ja/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/)
- [Docker における .NET の SBOM: 1 つのツールにすべてを見せようとするのはやめる](/ja/2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything/)
- [ローカルのマルチサービス開発における Aspire と Docker Compose の比較](/ja/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/)

## 参照元

- [Microsoft Artifact Registry のクライアント向けファイアウォール規則](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md)
- [Microsoft Artifact Registry のエンドポイントガイダンス](https://github.com/microsoft/containerregistry/blob/main/docs/mcr-endpoints-guidance.md)
- [dotnet/dotnet-docker: ASP.NET Core ランタイムのサポート対象タグ](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md)
- [Docker ドキュメント: docker-container ビルドドライバーのオプション](https://docs.docker.com/build/builders/drivers/docker-container/)
- [Docker ドキュメント: ビルド変数とプロキシのビルド引数](https://docs.docker.com/build/building/variables/)
- [moby/moby#49542: docker-container ドライバーの BuildKit がローカルイメージを使わない](https://github.com/moby/moby/issues/49542)
- [dotnet/core#8268: docker-compose build が mcr.microsoft.com からイメージを取得できない](https://github.com/dotnet/core/issues/8268)
