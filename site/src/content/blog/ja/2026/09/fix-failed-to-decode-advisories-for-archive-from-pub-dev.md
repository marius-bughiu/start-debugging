---
title: "修正: flutter pub get の Failed to decode advisories for archive from https://pub.dev"
description: "pub get のアドバイザリ警告は無害で、pub get は終了コード 0 で終わります。pub.dev は 2026-05-04 に不正なレスポンスを修正しました。今も表示される場合、原因はミラーかプロキシです。"
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "ci"
lang: "ja"
translationOf: "2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev"
translatedBy: "claude"
translationDate: 2026-09-25
---

パッケージは問題ありません。このメッセージは pub のセキュリティアドバイザリチェックから出ており、このチェックは依存関係の解決後に実行されます。`flutter pub get` は終了コード 0 のまま終わります。大量発生した件 (`archive`、`http`、`dio`、`shared_preferences_android` などに依存するすべてのプロジェクト) は pub.dev サーバーのバグでした。2026-05-02 から 2026-05-04 の間、アドバイザリ API が `"advisoriesUpdated": null` を返しており、pub.dev は 2026-05-04 にこれを修正しました。今でも表示される場合、レスポンスはパッケージミラー (`PUB_HOSTED_URL`、Artifactory、Nexus、プライベートな pub サーバー) かプロキシから来ています。そのサーバーを修正するか、Flutter 3.47.0 / Dart 3.13.0 以降にアップグレードしてください。これらのバージョンではスタックトレースが 1 行の警告に短縮されます。CI がこれで失敗する場合、本当の問題は stderr を失敗として扱うステップにあります。

以下のすべてのバリエーションを、macOS 上で Dart 3.12.2 (Flutter 3.44.x の SDK) と Dart 3.13.4 (Flutter 3.47.5 の SDK) を使って再現しました。どちらも、[hosted repository spec v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md) を実装し、アドバイザリエンドポイントが返す内容を選べる 40 行のローカル pub リポジトリに対して実行しています。

## エラーが出る状況

Flutter 3.44.x 以前 (Dart 3.12.x 以前) では、`flutter pub get` または `dart pub get` がパッケージごとに次の出力を次々と表示します。

```text
Resolving dependencies...
Downloading packages...
Failed to decode advisories for archive from https://pub.dev.
FormatException: advisoriesUpdated must be a String
package:pub/src/source/hosted.dart 670                        HostedSource._extractAdvisoryDetailsForPackage
package:pub/src/source/hosted.dart 622                        HostedSource._fetchAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 839                        HostedSource._getAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 1120                       HostedSource.getAdvisoriesForPackageVersion
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 425                        SolveReport._reportPackage
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 221                        SolveReport._reportChanges
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 76                         SolveReport.show
===== asynchronous gap ===========================
package:pub/src/entrypoint.dart 642                           Entrypoint.acquireDependencies
...
Failed to decode advisories for http from https://pub.dev.
FormatException: advisoriesUpdated must be a String
...
```

Flutter 3.47.0 以降 (Dart 3.13.0 以降) では、同じ状況でもパッケージごとに 1 行だけ出力されます。

```text
Failed to decode advisories for archive from https://pub.dev: advisoriesUpdated must be a String
```

最初に目にする名前はたいてい `archive` です。レポートはパッケージをアルファベット順に処理し、`archive` は `image` や多くのビルドツールの推移的依存関係なので、ほとんどの Flutter のロックファイルで早い位置に現れます。フェッチが発生するのは、過去に一度でもセキュリティアドバイザリが出たパッケージだけです。そのため `http` と `dio` はどのレポートにも登場し、`path` は一度も登場しませんでした。

## そもそも pub がアドバイザリを取得する理由

Dart 3.4 ([dart-lang/pub#4062](https://github.com/dart-lang/pub/pull/4062)) 以降、`pub get`、`pub upgrade`、`pub add` は、解決したバージョンに対する既知のセキュリティアドバイザリを報告します。データの出どころは [osv.dev](https://osv.dev) で、pub.dev はそれを API の 2 つのフィールドを通じて再公開しています。

1. バージョン一覧 `GET /api/packages/<name>` には、省略可能な `advisoriesUpdated` タイムスタンプがあります。これが存在する場合、クライアントはサーバーがそのパッケージのアドバイザリエンドポイントをサポートしているとみなします。
2. アドバイザリエンドポイント `GET /api/packages/<name>/advisories` は `{"advisories": [...], "advisoriesUpdated": "<date-time>"}` を返します。

クライアントは 2 つ目のレスポンスを `$PUB_CACHE/hosted/<host>/.cache/<name>-advisories.json` にキャッシュし、タイムスタンプを使ってそのキャッシュが古いかどうかを判断します。[`hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart) の `_extractAdvisoryDetailsForPackage` では、パーサーがタイムスタンプを厳格にチェックします。

```dart
// dart-lang/pub, lib/src/source/hosted.dart (Dart 3.12 and 3.13)
final advisoriesUpdated = body['advisoriesUpdated'];
if (advisoriesUpdated is! String) {
  throw const FormatException('advisoriesUpdated must be a String');
}
```

この `FormatException` は `_fetchAdvisories` でキャッチされ、警告としてログ出力され、メソッドは `null` を返します。これは「このパッケージのアドバイザリデータはない」という意味です。その時点で依存関係の解決はすでに完了しており、`pubspec.lock` の内容はこれに一切依存しません。失われるのは、そのパッケージのアドバイザリレポートだけです。

## 2026 年 5 月に pub.dev で何が壊れたのか

pub.dev チームの[ポストモーテム](https://github.com/dart-lang/pub-dev/issues/9372)に経緯が説明されています。2026-04-23、よりスリムな `FROM scratch` の Docker イメージで `unzip` が削除され、osv.dev のエクスポートをダウンロードするジョブが動かなくなりました。2026-05-01 にこれは Dart による unzip 実装に置き換えられましたが、その実装には `init()` の呼び出しが欠けていました。この実装は 1 つもファイルを展開しなかったため、2026-05-02 の次回同期ではアドバイザリが 1 件も「見つからず」、データストアからすべて削除されてしまいました。

アドバイザリエンドポイントは `advisoriesUpdated` を保存済みの最新のアドバイザリから導出していましたが、1 件も残っていなかったため `null` を返しました。一方、バージョン一覧にはパッケージエンティティ由来の古いタイムスタンプが残っていました。そのため、すべてのクライアントが「このパッケージにはアドバイザリがある」と判断してそれを取得し、次のレスポンスで処理に失敗しました。

```json
{"advisories": [], "advisoriesUpdated": null}
```

[dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368) ("Fix advisoriesUpdated") は 2026-05-04 にリリースされました。アドバイザリは再読み込みされ、issue は 2026-05-05 にクローズされています。現在、アドバイザリのないパッケージは `null` ではなく Unix エポックを返します。

```bash
# pub.dev, checked 2026-09-25
curl -s https://pub.dev/api/packages/path/advisories
# {"advisories":[],"advisoriesUpdated":"1970-01-01T00:00:00.000"}
```

クライアント側では、[dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817) ("Quiet warning instead of stack trace when failing to parse advisories") によってスタックトレースが 1 行のメッセージに置き換えられました。各リリースタグについて、Dart SDK の `DEPS` ファイルで固定されている `pub_rev` を確認しました。この変更は 3.12.0 から 3.12.2 には含まれておらず、3.13.x のすべてのリリースには含まれています。Flutter でいうと、3.44.0 から 3.44.9 はまだ完全なトレースを出力し、3.47.0 が出力しない最初の stable です。

## ローカル pub サーバーによる最小再現

これを確認するのに pub.dev が壊れている必要はありません。リポジトリ仕様に従い、アドバイザリのレスポンスを切り替えられる小さな Node サーバーで、すべてのバリエーションを再現できます。関連する部分は次のとおりです。

```js
// Node 24, server.mjs: minimal pub repository (spec v2)
if (req.url === '/api/packages/fakepkg') {
  res.writeHead(200, { 'content-type': 'application/vnd.pub.v2+json' });
  return res.end(JSON.stringify({
    name: 'fakepkg',
    advisoriesUpdated: '2026-04-20T10:00:00.000Z', // tells pub to fetch advisories
    latest: { version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec },
    versions: [{ version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec }],
  }));
}
if (req.url === '/api/packages/fakepkg/advisories') {
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ advisories: [], advisoriesUpdated: null }));
}
```

アプリは依存関係の 1 つをそこに向けます。

```yaml
# pubspec.yaml, Dart 3.12.2 / 3.13.4
name: app
publish_to: none
environment:
  sdk: ^3.0.0
dependencies:
  fakepkg:
    hosted: http://localhost:8123
    version: ^1.0.0
```

両方の SDK で、毎回新しい `PUB_CACHE` を使って実行します。

```bash
# Dart 3.12.2
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# out.txt: Resolving dependencies... Downloading packages... + fakepkg 1.0.0  Changed 1 dependency!
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123.
#          FormatException: advisoriesUpdated must be a String
#          package:pub/src/source/hosted.dart 648  HostedSource._extractAdvisoryDetailsForPackage
#          ... (full async stack trace)

# Dart 3.13.4
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123: advisoriesUpdated must be a String
```

この再現で具体的にわかることが 3 つあります。

- **どちらのバージョンでも終了コードは 0 です。** パッケージはダウンロードされ、`pubspec.lock` も書き込まれます。
- **すべて stderr に出力されます。** stdout はきれいなままです。
- **不正なレスポンスは決してキャッシュされません。** 実行後、`$PUB_CACHE/hosted/localhost%588123/.cache/` には `fakepkg-versions.json` はありますが `fakepkg-advisories.json` はありません。キャッシュの書き込みはパースが成功した後に行われるため、pub は毎回、何も変わっていない `pub get` でも改めて問い合わせます。pub キャッシュを削除しても解決しません。キャッシュは最初から問題ではなかったからです。これは、pub-dev の issue で `flutter pub cache clean` を実行してもエラーが出続けたという報告と一致します。

## 修正方法 (可能性の高い順)

### 1. レスポンスの出どころを確認する

詳細出力付きで get を実行し、アドバイザリのリクエストを探します。

```bash
# Flutter 3.47.5 / Dart 3.13.4
dart pub get --verbose 2>&1 | grep -A3 "Fetching security advisories"
# IO  : Fetching security advisories from https://pub.dev/api/packages/archive/advisories.
# IO  : HTTP GET https://pub.dev/api/packages/archive/advisories
```

次に、その URL を自分で直接取得します。

```bash
curl -s https://pub.dev/api/packages/archive/advisories | head -c 300
```

ホストが `pub.dev` で、ボディの `advisoriesUpdated` が文字列であれば、サーバー側は正常です。それでもメッセージが残る場合、原因はあなたと pub.dev の間にある何か、たいていはレスポンスを書き換える TLS インスペクション型のプロキシです。ホストが pub.dev でない場合は、`echo $PUB_HOSTED_URL` と `pubspec.yaml` 内の `hosted:` URL を確認してください。そのサーバーが原因です。

### 2. CI が警告を失敗として扱わないようにする

pub は終了コード 0 で終わるので、このメッセージでパイプラインが赤くなったのであれば、どこかのステップが stderr への出力で失敗しています。よくある原因は、`failOnStderr: true` を設定した Azure Pipelines の script タスクと、`$ErrorActionPreference = 'Stop'` の下で `flutter pub get 2>&1` を実行する Windows PowerShell 5.1 のスクリプトです。PowerShell 5.1 はリダイレクトされた stderr の各行を `ErrorRecord` に変換し、`Stop` の場合は最初の 1 行でスクリプトが終了します。代わりに終了コードで判定してください。

```yaml
# Azure Pipelines, Flutter 3.47.5
- script: flutter pub get
  displayName: Restore packages
  failOnStderr: false   # pub prints advisory warnings to stderr and still exits 0
```

```powershell
# Windows PowerShell 5.1, Flutter 3.47.5
$ErrorActionPreference = 'Continue'
flutter pub get
if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed ($LASTEXITCODE)" }
```

ログを `Exception` や `Error` で grep するラッパーも同じ問題に当たります。[`version solving failed`](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/) のような本当の解決失敗は 0 以外の終了コードを設定するので、終了コードだけで十分です。

### 3. Flutter 3.47.0 以降にアップグレードする

これで警告が消えるわけではありませんが、1 行の形式ならログ上でずっと目立たず、本当に見たい出力を埋もれさせません。CI でブランチごとに Flutter を固定している場合は、[1 つの CI パイプラインで複数の Flutter バージョンをターゲットにする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)方法を使えば、他のジョブに触れずにデフォルトのジョブを 3.47.x に移行できます。

### 4. ミラーまたはプライベート pub サーバーを修正する

仕様はミラーに 2 つの正しい選択肢を与えており、どちらかを選ぶ必要があります。

- `/api/packages/<name>/advisories` を忠実にプロキシし、`advisoriesUpdated` を常に文字列にする。
- または、提供するバージョン一覧から `advisoriesUpdated` を取り除く。仕様上このフィールドは省略可能で、存在しない場合クライアントはアドバイザリエンドポイントをまったく呼び出しません。アドバイザリレポートは失われますが、pub は問い合わせをやめます。

Artifactory や類似製品のリモートリポジトリは、アップストリームのメタデータをキャッシュします。pub-dev の issue にいたある Artifactory ユーザーは別の失敗に遭遇しました。プロキシ自身のパーサーが `null` フィールドで `NullPointerException` を投げたのです。プロキシが 2026 年 5 月の期間のレスポンスをキャッシュしている場合、そのリモートリポジトリのメタデータキャッシュをクリアすると (Artifactory ではこれを "zap cache" と呼びます)、修正済みのレスポンスを取得するようになります。これはプロキシの運用者が行う必要があります。クライアント側で何をしても変わりません。

### 5. 本当に問題にならない場所ではチェックをスキップする

`dart pub get --offline` / `flutter pub get --offline` はアドバイザリを一切取得しません。オフラインモードではコードが早期リターンします。これはすべてのパッケージがすでにローカルの pub キャッシュにある場合にのみ機能するので、キャッシュを事前に温めたハーメティックなビルドエージェント向けであり、一般的な修正ではありません。開発者のマシンで壊れたミラーを隠すために使わないでください。チェックの存在理由であるセキュリティレポートも失われるからです。

## よく似たバリエーション

**`Failed to decode advisories for X from ...: Unexpected character (at character 1)`** の後に HTML の行が続くもの。アドバイザリのリクエストが HTML ページを受け取っています。典型的にはキャプティブポータル、プロキシのログイン画面、または HTTP 200 を返すエラーページです。`<html>proxy login</html>` を返すことで再現しました。終了コードはやはり 0 で、修正すべきは pub ではなくネットワーク経路です。

**`Warning: Unable to fetch advisories for "X" from "https://my-mirror/"`**。pub.dev 以外のホストで、アドバイザリエンドポイントが 2xx 以外のステータスを返しています。これは警告で、終了コードは 0 です。この挙動は 2024 年の [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275) にさかのぼります。それ以前は、エンドポイントを持たないミラーで `pub get` がクラッシュしていました。

**`Failed to fetch advisories for "X" from "https://pub.dev"`**。同じ状況ですが、ホストが pub.dev です。pub.dev は常にエンドポイントを提供しているはずなので、pub はこれを致命的なもの (`fail(...)`) として扱い、0 以外の終了コードで終了します。これが表示された場合は、本当に pub.dev の障害か、その経路を何かがブロックしています。ローカルで何かを変更する前に、[pub.dev の issue トラッカー](https://github.com/dart-lang/pub-dev/issues)を確認してください。

**`FormatException: advisories must be a list`** または **`advisory must be a map`**。同じコードパスで、不正な形式のフィールドが異なるだけです。自作の pub サーバーが誤った形のデータを返しています。そのレスポンスを仕様の OSV フォーマットのセクションと比較してください。

## 関連記事

- [修正: pubspec.yaml の version solving failed](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/) では、本当にビルドを止める pub のエラーと、その出力の読み方を扱っています。
- [1 つの CI パイプラインで複数の Flutter バージョンをターゲットにする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)。CI を 3.47.x の SDK に移行する際に役立ちます。
- [再現可能なビルドのための Flutter エンジンバージョンの固定](/ja/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)。エージェントがどの SDK を実行しているかを正確に把握していれば、3.44 の出力と 3.47 の出力を見分けられます。
- [修正: Unexpected failure parsing device information from adb output](/ja/2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter/) も、特定の SDK バージョンにすることが正しい対処となる、騒がしい Flutter ツールのメッセージです。
- [Flutter 3.47.1 ホットフィックスに含まれたその他の変更](/ja/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/)。

## 出典

- [dart-lang/pub-dev#9372](https://github.com/dart-lang/pub-dev/issues/9372)。最初の報告とポストモーテム、および重複 issue の [dart-lang/sdk#63308](https://github.com/dart-lang/sdk/issues/63308) と [flutter/flutter#185943](https://github.com/flutter/flutter/issues/185943)。
- [dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368)。サーバー側の修正。
- [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817)。より静かなクライアントの警告。および [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275)。アドバイザリエンドポイントがない場合の穏当な処理。
- dart-lang/pub の [`lib/src/source/hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart) (`_fetchAdvisories`、`_extractAdvisoryDetailsForPackage`、`_getAdvisories`)。
- [Hosted Pub Repository Specification v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md)。`advisoriesUpdated` と "List security advisories for a package" のセクション。
- 3.12.x と 3.13.x のタグにおける [Dart SDK `DEPS`](https://github.com/dart-lang/sdk/blob/3.13.0/DEPS) (`pub_rev`)、および Flutter と Dart の対応関係を示す [Flutter releases manifest](https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json)。
- dart.dev の [Troubleshooting pub](https://dart.dev/tools/pub/troubleshoot)。
