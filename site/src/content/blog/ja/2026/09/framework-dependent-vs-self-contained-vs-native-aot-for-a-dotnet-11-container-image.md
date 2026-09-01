---
title: ".NET 11 のコンテナーイメージにおける framework-dependent と self-contained と Native AOT の比較"
description: "ASP.NET Core サービスを .NET 11 で動かすなら、chiseled な aspnet イメージ上の framework-dependent が正しい既定です。ランタイムのレイヤーがサービス間で共有され、ランタイムの CVE はベースイメージの差し替えだけで塞げるからです。self-contained + トリミングと Native AOT はイメージを 2 倍から 5 倍小さくし、コールドスタートを大幅に速くしますが、その代わりに前述の利点を失います。実測された公開サイズ、共有レイヤーの計算、そして AOT の経路を壊す .NET 11 のベースイメージ推論バグを扱います。"
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "containers"
  - "docker"
  - "native-aot"
  - "deployment"
lang: "ja"
translationOf: "2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image"
translatedBy: "claude"
translationDate: 2026-09-01
---

.NET 11 上の一般的な長時間稼働の ASP.NET Core サービスであれば、**chiseled な `aspnet` イメージ上に framework-dependent で発行**してください。実際に出荷するものとしては最小であり (他のサービスがすでに取得済みのランタイムレイヤーの上に、数メガバイトのアプリケーションが乗るだけです)、ランタイムの CVE はアプリケーションを作り直してテストし直して再デプロイするのではなく、新しいベースイメージタグで再ビルドするだけで塞げます。アプリケーションが特定のランタイムパッチに固定される必要がある場合や、.NET がまったく入っていないベースイメージ上で動かす必要がある場合は、**self-contained + トリミング**に切り替えてください。**Native AOT** に手を伸ばすのは、コールドスタートまたは Pod あたりのメモリーが支配的な制約であり、かつ依存関係ツリー全体に対して `dotnet publish` が AOT 警告をひとつも出さない場合だけにしてください。AOT について語られるサイズの数字は本物ですが、フリートで見ると測っている対象が違います。framework-dependent なイメージはノード上のすべてのサービスでひとつのランタイムレイヤーを共有しますが、self-contained と AOT のイメージは共有しません。

ここでの内容はすべて `<TargetFramework>net11.0</TargetFramework>` を対象にしています。執筆時点で .NET 11 は Preview 7 (`11.0.100-preview.7.26381.103`、2026-08-11 リリース) であり、[正式版は 2026 年 11 月が予定されています](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview)。プレビューのイメージタグには正式版で外れる `-preview` 修飾子が付くため、今日の `11.0-preview-resolute-chiseled` は 11 月には `11.0-resolute-chiseled` になります。以下の仕組みは .NET 8 以降安定しているので、ほぼすべてが .NET 9 と .NET 10 にもそのまま当てはまります。

## コンテナーイメージとしての 3 つのモード

| 項目 | framework-dependent | self-contained + トリミング | Native AOT |
| --- | --- | --- | --- |
| ベースイメージのリポジトリ | `dotnet/aspnet` または `dotnet/runtime` | `dotnet/runtime-deps` | `dotnet/runtime-deps` |
| ランタイムの置き場所 | ベースイメージのレイヤー | アプリケーションのレイヤー | バイナリー内にコンパイル済み |
| ランタイムレイヤーがサービス間で共有される | はい | いいえ | いいえ |
| ランタイムの CVE への対応 | 新しいベースタグを取得して再ビルド | 新しい SDK、再ビルド、再テスト、再デプロイ | 新しい SDK、再ビルド、再テスト、再デプロイ |
| インストール済みパッチへのロールフォワード | はい | いいえ | いいえ |
| 有効化する方法 | 何もしない (既定) | `--self-contained -p:PublishTrimmed=true` | `-p:PublishAot=true` |
| RID が必要か | いいえ | はい | はい |
| ビルドホストに C ツールチェーンが必要か | いいえ | いいえ | はい (clang、zlib1g-dev) |
| リフレクション、`Reflection.Emit`、プラグイン読み込み | 完全に使える | トリミング警告、実行時の失敗の可能性 | 制限あり、または利用不可 |
| サンプルイメージ、圧縮後 | 52.81 MB | 21.86 MB | 11.60 MB |

最後の 3 つの数字は `dotnet/dotnet-docker` にある [.NET コンテナーイメージのサイズレポート](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md) からのもので、`releasesapi` サンプルを .NET 10.0 と `noble-chiseled` ベースイメージで測定した値です。詳細はすぐ後で説明します。この行こそが誤解を生むからです。

## 各モードが実際にイメージへ入れるもの

SDK のコンテナーツールはプロジェクトからベースイメージを推論します。規則は短いものです。[コンテナー化のリファレンス](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration)によれば、self-contained なプロジェクトには `mcr.microsoft.com/dotnet/runtime-deps` が、ASP.NET Core プロジェクトには `mcr.microsoft.com/dotnet/aspnet` が、それ以外には `mcr.microsoft.com/dotnet/runtime` が使われます。タグは TFM の数値部分で、`ContainerFamily` がサフィックスとして付きます。

この推論がすべてです。

- **framework-dependent** は `aspnet` に着地します。これは `runtime-deps` に .NET ランタイムと ASP.NET Core の共有フレームワークを足したものです。あなたのレイヤーには IL アセンブリーと静的アセットが入り、通常は 1 桁メガバイトです。
- **self-contained** は `runtime-deps` に着地します。ここには .NET が必要とするネイティブライブラリー (libc、OpenSSL など) だけがあり、.NET 自体は入っていません。あなたのレイヤーがランタイムと共有フレームワークをまるごと運ぶことになるので、ここではトリミングが効いてきます。
- **Native AOT** も `runtime-deps` に着地しますが、あなたのレイヤーは IL も JIT も持たないネイティブ実行ファイル 1 つです。なお `runtime-deps` の `-aot` サフィックスはもう存在しません。.NET 8 にはありましたが、.NET 10 で AOT 専用の runtime-deps タグは通常の `-chiseled` タグに統合されました。`-aot` サフィックスは今では **SDK** イメージ側 (`sdk:11.0-preview-aot`、`sdk:11.0-preview-resolute-aot`) にあり、AOT コンパイラーがビルド時に必要とする clang と zlib のツールチェーンを同梱しています。

3 つとも Microsoft イメージの同じ堅牢化を継承します。UID 1654 の非 root ユーザー `app` (`$APP_UID` で公開) と、80 ではなく 8080 のポートで、いずれも [.NET 8 で導入されました](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers)。chiseled イメージにはさらにシェルもパッケージマネージャーも `curl` も入っていないので、chiseled ファミリーを選んだ場合は 3 つのモードのいずれでも `docker exec` によるデバッグやシェルベースのヘルスチェックは動きません。

## 3 つそれぞれの発行方法

framework-dependent。RID は不要で、chiseled な ASP.NET Core ベースへ直接発行します。

```bash
# .NET 11 SDK 11.0.100-preview.7. Framework-dependent onto aspnet:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

self-contained + トリミング。`PublishTrimmed` は `SelfContained` を含意しますが、後で読む人がそれを覚えていなくて済むように両方書いておきます。

```bash
# .NET 11 SDK 11.0.100-preview.7. Self-contained + trimmed onto runtime-deps:11.0-preview-resolute-chiseled.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  --self-contained \
  -p PublishTrimmed=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

Native AOT。`PublishAot` は self-contained を含意し、ビルドマシンにプラットフォームの C ツールチェーンが必要です。

```bash
# .NET 11 SDK 11.0.100-preview.7. Native AOT onto runtime-deps:11.0-preview-resolute-chiseled.
# Requires clang and zlib1g-dev locally, or build inside sdk:11.0-preview-aot.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled \
  -p ContainerRepository=orders-api
```

エージェントに clang を入れずに CI から実行したい場合、SDK の AOT イメージはまさにそのために存在します。

```dockerfile
# .NET 11 preview. Multi-stage AOT build.
FROM mcr.microsoft.com/dotnet/sdk:11.0-preview-resolute-aot AS build
WORKDIR /src
COPY . .
RUN dotnet publish OrdersApi/OrdersApi.csproj -c Release -r linux-x64 -p:PublishAot=true -o /app

FROM mcr.microsoft.com/dotnet/runtime-deps:11.0-preview-resolute-chiseled
WORKDIR /app
COPY --from=build /app/OrdersApi .
USER $APP_UID
ENTRYPOINT ["./OrdersApi"]
```

`Container*` プロパティーの全体像、タグの制御、レジストリー認証については、[Dockerfile なしで .NET 11 アプリケーションをコンテナーイメージとして発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)を参照してください。

## 公開されているサイズの数字

Microsoft はサンプルの最小 web API について、すべてのベースイメージバリアントでの実測サイズを公開しているので、推測する必要はありません。以下は .NET 10.0 における `releasesapi` サンプルの圧縮後サイズです。

| ベースイメージ | framework-dependent | self-contained + トリミング | Native AOT |
| --- | --- | --- | --- |
| フル Ubuntu (`10.0`) | 92.48 MB | 61.53 MB | 51.27 MB |
| `10.0-noble-chiseled` | 52.81 MB | 21.86 MB | 11.60 MB |
| `10.0-noble-chiseled-extra` | 67.68 MB | 36.82 MB | 26.56 MB |
| `10.0-alpine` | 51.93 MB | 20.95 MB | 10.69 MB |
| `10.0-alpine-extra` | 66.50 MB | 35.52 MB | 25.25 MB |

この表からすぐに 2 つのことが読み取れます。第 1 に、**ベースイメージのファミリーはデプロイモードよりも大きなレバーです**。framework-dependent なアプリケーションをフル Ubuntu イメージから `noble-chiseled` に移すと 39.67 MB 減りますが、これは同じアプリケーションをフルイメージ上で framework-dependent から Native AOT に切り替えて得られる削減 (41.21 MB) に匹敵し、しかも互換性の作業を一切必要としません。まだ chiseled にしていないなら、まずそれをやって測り直してから、他を検討してください。

第 2 に、chiseled の Native AOT は chiseled の framework-dependent より確かにおよそ 4.5 倍小さくなります。これは本物の利点で、scale-to-zero の関数や非常に高密度なノードでは決め手になります。

## サイズの議論をひっくり返す共有レイヤーの計算

ここからは、サイズレポートには示せない部分です。あのレポートはイメージを 1 つずつ独立に測っているからです。

コンテナーイメージはコンテンツアドレッシングされたレイヤーの集まりです。10 個のサービスがすべて `FROM mcr.microsoft.com/dotnet/aspnet:11.0-preview-resolute-chiseled` でビルドされていれば、それらを動かすノードはそのランタイムレイヤーを 1 回だけ取得して保存します。11 個目のサービスの限界コストは自身のアプリケーションレイヤーだけであり、framework-dependent な ASP.NET Core サービスならそれは数メガバイトの IL です。

上の chiseled の列を使って、1 ノードに 10 サービスある場合を計算してみます。

- **framework-dependent**: 共有される `aspnet` レイヤーがおよそ 50 MB、加えて 1 つ約 3 MB のアプリケーションレイヤーが 10 個。だいたい 80 MB です。
- **self-contained + トリミング**: 数メガバイトの共有 `runtime-deps` レイヤーに加え、それぞれがトリミング済みのランタイムのコピーを持つアプリケーションレイヤーが 10 個。おおよそ 10 x 20 MB で、約 200 MB です。
- **Native AOT**: 同じ形で 10 x 11 MB、約 110 MB です。

self-contained は単一イメージでは framework-dependent に 2.4 倍の差で勝つのに、フリート規模では 3 つの中で最悪になります。トリミングはアプリケーション単位で行われ、アプリケーションをまたいで重複排除できないからです。Native AOT は十分小さいので先頭を保ちますが、その差は 4.5 倍から 2 倍を大きく下回るところまで縮みます。レジストリーのストレージ、AZ をまたぐ取得帯域、ノードのディスク圧迫は、最初の計算ではなくこの 2 番目の計算に従います。サイズを理由に何かを移行する前に、自分のフリートを測ってください。

## パッチ適用: ランタイムの CVE は誰が塞ぐのか

ほとんどのチームにとって実際に判断を決めるべきなのはこの議論であり、[発行の概要](https://learn.microsoft.com/en-us/dotnet/core/deploying/)がはっきり書いている点でもあります。framework-dependent なアプリケーションは「アプリを実行する環境で利用可能な最新の .NET セキュリティパッチに自動的にロールフォワードする」一方、self-contained な配置は「ロールフォワードしない」ため「.NET ランタイムはアプリの新しいバージョンをリリースすることでしかアップグレードできない」とされています。

コンテナーの言葉に直すと次のようになります。

- **framework-dependent**: Microsoft が計画外のランタイム修正を出したら、タグを付け替えて再ビルドし、再デプロイします。あなたのコードはバイト単位で同一なので、この変更は機械的に安全です。ベースイメージ更新の自動化 (Dependabot、Renovate) が人手なしでこなせますし、リポジトリーあたり 1 つの PR で足ります。
- **self-contained と Native AOT**: ランタイムがアプリケーションのレイヤーの中にあるため、修正にはビルドエージェント上の新しい SDK、フルビルド、フルのテスト実行がサービスごとに必要です。特に AOT ではネイティブコードの再コンパイルも意味し、これは手持ちで最も遅いビルドです。

「重大な CVE を N 日以内に修正する」という統制が組織にあるなら、この差は脚注ではありません。何かに強制されない限り framework-dependent に留まるべき理由そのものです。

## グローバリゼーションは chiseled と chiseled-extra を分ける隠れたスイッチ

素の `-chiseled`、`-alpine`、および Azure Linux の `-distroless` イメージは ICU と tzdata を含まないため、グローバリゼーション不変モードのアプリケーションでしか動きません。`-extra` バリアントは ICU、tzdata、`libstdc++` を戻すもので、サイズ表にあった 15 MB の差はこれです。

self-contained と AOT の発行では SDK が助けようとします。`InvariantGlobalization` が false なら `-extra` バリアントへ誘導してくれます。framework-dependent の発行ではファミリーを自分で選ぶので、プロパティーを合わせるのはあなたの責任です。

```xml
<!-- .NET 11, net11.0. Required if you target a plain -chiseled or -alpine base. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

ここを間違えるとコンテナーは起動時に `Couldn't find a valid ICU package installed on the system` で落ちます。これには[専用の解決記事](/ja/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/)があります。そして不変モードはただではありません。カルチャーを考慮する文字列比較、非 ASCII に対する `ToUpper` と `ToLower`、`TimeZoneInfo` の参照はすべて挙動が変わります。何かをローカライズしたり通貨を書式化したりするなら、`-extra` の 15 MB を払ってください。

## .NET 11 の落とし穴: ベースイメージ推論がいまだに noble を返す

コンテナーツールは推論するタグ用の Ubuntu コードネームを SDK のバージョンから計算しますが、.NET 11 のプレビュー時点でその対応表は `jammy` (SDK が 8.0.300 未満) と `noble` (8.0.300 以上) しか知りません。`11.0.100` は 2 番目の条件を満たすので `noble` が返りますが、MCR 上の .NET 11 イメージは `resolute` (Ubuntu 26.04) で公開されています。結果は [dotnet/sdk#53553 として報告](https://github.com/dotnet/sdk/issues/53553)されているとおりです。

```console
error CONTAINER1015: Unable to access the repository 'dotnet/runtime-deps' at tag '11.0.0-preview.2-noble-chiseled-extra'
```

影響範囲は、まさにこの記事が扱っている経路です。framework-dependent な発行は問題ありません。コードネーム推論の分岐を通らないからです。トリミングした self-contained と `PublishAot=true` の発行は両方ともこれを踏みます。対処は推論に頼るのをやめてファミリーを明示することで、上のコマンドがすべてそれを渡しているのはそのためです。

```bash
# .NET 11 SDK 11.0.100-preview.7. Explicit family, no codename inference.
dotnet publish --os linux --arch x64 /t:PublishContainer \
  -p PublishAot=true \
  -p ContainerFamily=resolute-chiseled
```

`ContainerBaseImage` に完全修飾名を設定するのも有効で、その場合は `ContainerFamily` を完全に迂回します。いずれにせよファミリーを明示的に固定するのは良い習慣です。将来の SDK が黙ってフリートを別のディストリビューションへ動かしてしまうのを防げます。[Ubuntu 26.04 のタグのローテーション](/ja/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/)は .NET 10 側から見た同じ教訓です。

## 選択を決めてしまう制約

ほとんどのチームはサイズを比較検討する段階までたどり着きません。ひとつの厳しい制約が決めてしまうからです。

- **リフレクションを多用する依存関係。** 動的プロキシー、リフレクションベースのシリアライザー、実行時にコードを生成する DI コンテナー、プラグイン読み込み。Native AOT は選択肢から外れ、トリミングも危険です。ドキュメントではなく発行時の警告を可否の判断材料として扱ってください。[トリミング安全なコード](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)は両者の前提条件です。
- **CVE 対応の期限がある。** framework-dependent です。ベースイメージの更新は機械的な変更ですが、再ビルドはそうではありません。
- **scale-to-zero やリクエスト課金。** コールドスタートが請求額を左右します。Native AOT は通常の JIT よりおよそ 3 倍速く起動し、ワーキングセットは半分未満です ([.NET 11 における Native AOT と ReadyToRun と JIT の比較](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)の実測による)。
- **複数プラットフォーム向けにビルド成果物をひとつだけ作りたい。** RID なしの framework-dependent だけが単一の成果物を生みます。他の 2 つは RID ごとで、ビルドマトリックスが必要です。
- **自分で管理していない、.NET が入っていないベースイメージ。** self-contained です。適切なネイティブライブラリーだけを持つ任意のディストリビューションイメージ上で動く唯一のモードだからです。

## 推奨、あらためて

既定は **`aspnet:11.0-<family>-chiseled` 上の framework-dependent** です。フリート規模で最も安いイメージであり、ランタイムの CVE がリリースではなくベースイメージの更新で済む唯一のモードであり、RID に依存しない単一成果物を出荷できる唯一のモードでもあります。コールドスタートまたはメモリー密度が拘束条件であり、依存関係ツリーがクリーンに発行できるなら **`runtime-deps:11.0-<family>-chiseled` 上の Native AOT** へ移ってください。ランタイムのバージョン固定や .NET のないベースイメージが必要な場合の中間案として **self-contained + トリミング**を使ってください。ただしフリート全体のストレージという観点では 3 つの中で最悪であることは理解しておいてください。どれを選ぶにせよ `ContainerFamily` は明示的に設定し、他の最適化に手を付ける前にイメージを chiseled にしてください。

## 関連記事

- [dotnet publish /t:PublishContainer で .NET 11 アプリケーションをコンテナーイメージとして発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)は、これらのコマンドが依存する `Container*` プロパティーの全体像を扱っています。
- [.NET 11 における Native AOT と ReadyToRun と JIT の比較](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)は、このパッケージングの比較の下にあるコンパイルモデルの比較で、起動時間とスループットの実測を含みます。
- [Native AOT とは何か、そして何を犠牲にするのか](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)は、決断する前に API とライブラリーの制約を洗い出します。
- [トリミング安全なコードとは何か、どう書くのか](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)は、トリミングした self-contained と AOT の双方の前提条件です。
- [dotnet build と dotnet publish の違いは何か](/ja/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)は、なぜこれらすべてが発行時にしか起こらないのかを説明します。

## 参考資料

- [.NET アプリケーションの発行の概要](https://learn.microsoft.com/en-us/dotnet/core/deploying/)、MS Learn (framework-dependent と self-contained のトレードオフ、ロールフォワード、AOT)。
- [.NET アプリケーションのコンテナー化リファレンス](https://learn.microsoft.com/en-us/dotnet/core/containers/publish-configuration)、MS Learn (`ContainerBaseImage` の推論、`ContainerFamily`、`ContainerUser`)。
- [.NET コンテナーイメージ](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images)、MS Learn (リポジトリー、chiseled と extra のバリアント、グローバリゼーション)。
- [サンプルイメージのサイズレポート](https://github.com/dotnet/dotnet-docker/blob/main/documentation/sample-image-size-report.md)、`dotnet/dotnet-docker` (`releasesapi` サンプルの実測サイズ)。
- [ベースイメージ推論が .NET 11 で誤った Ubuntu コードネームを使う](https://github.com/dotnet/sdk/issues/53553)、`dotnet/sdk` (CONTAINER1015、`ContainerFamily` による回避策)。
- [.NET 8 のコンテナーの新機能](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/containers)、MS Learn (非 root ユーザー `app`、`APP_UID`、ポート 8080)。
- [.NET 11 の新機能](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview)、MS Learn (プレビュー状況、正式版の時期、SDK のコンテナー関連の変更)。
