---
title: "修正: Dart 3.13 の Docker イメージで発生する CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate"
description: "Dart 3.13 で VM に組み込まれていたフォールバック用ルート証明書が削除されました。ランタイムイメージに CA バンドルを入れてください。dart:stable から COPY /runtime/ するか、ca-certificates をインストールします。"
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "docker"
  - "tls"
  - "dart-3-13"
lang: "ja"
translationOf: "2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image"
translatedBy: "claude"
translationDate: 2026-09-30
---

Dockerfile は変わっていません。変わったのは Dart です。Dart 3.13.0 (Flutter 3.47.0 の SDK であり、2026 年 8 月以降 `dart:stable` タグが指している SDK で、現在は 3.13.5) から、スタンドアロン VM にはルート証明書のフォールバックセットがコンパイル済みの形で含まれなくなりました。アプリを実行するイメージの標準的な Linux パスのどこにも CA バンドルがない場合、すべての HTTPS 呼び出しがハンドシェイクに失敗します。修正するには、ランタイムステージにトラストストアを用意します。`FROM scratch` ステージで `COPY --from=build /runtime/ /` を維持するか、slim ベースイメージで `apt-get install ca-certificates` を実行してください。イメージを変更できない場合は、`DART_VM_OPTIONS=--root-certs-file=/path/to/cacert.pem` で VM に PEM ファイルを指定できます。

以下の内容は、`3.12.2`、`3.13.0`、`3.13.5` の各タグにおける Dart SDK のソース、`dart-lang/dart-docker` の `stable/trixie` Dockerfile、そしてこの挙動が意図的なものであると Dart チームが確認した [dart-lang/sdk#64060](https://github.com/dart-lang/sdk/issues/64060) のやり取りに基づいています。

## エラーの状況

アプリのビルドも起動も問題なく完了します。最初の外向き TLS 接続で、`HttpClient`、`package:http`、`dio`、gRPC チャネル、データベースドライバーのいずれを経由する場合でも、次の例外が発生します。

```text
HandshakeException: Handshake error in client (OS Error:
	CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:320))

#0      _SecureFilterImpl._handshake (dart:io-patch/secure_socket_patch.dart:101)
#1      _SecureFilterImpl.handshake (dart:io-patch/secure_socket_patch.dart:146)
#2      _RawSecureSocket._secureHandshake (dart:io/secure_socket.dart:995)
#3      _RawSecureSocket._tryFilter (dart:io/secure_socket.dart:1127)
<asynchronous suspension>
```

手がかりは発生のタイミングです。同じコード、同じ Dockerfile、同じエンドポイントが `dart:3.12.2` では動作していました。ビルドステージを `dart:3.12.2` に戻すとエラーが消えます。#64060 の報告者も、原因を突き止める前にまさにこの方法を取りました。有効な公開証明書を持つエンドポイント (pub.dev、googleapis.com、自前の Let's Encrypt API) も、自己署名のものと同じように失敗します。問題はサーバー側の証明書チェーンではなく、クライアントが何も信頼していないことだからです。

## Dart 3.13 が素のイメージで何も信頼しなくなった理由

Linux では、`runtime/bin/security_context_linux.cc` の `SSLCertContext::TrustBuiltinRoots()` が、次の固定された順序で信頼するルートを探します。

1. `--root-certs-file` または `--root-certs-cache` オプション (指定した場合)。
2. `/etc/ssl/certs/ca-certificates.crt`、`/etc/pki/tls/certs/ca-bundle.crt`、`/etc/ssl/ca-bundle.pem`、`/etc/pki/tls/cacert.pem`、`/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem` のうち、最初に存在するバンドルファイル。
3. `/etc/ssl/certs`、`/system/etc/security/cacerts`、`/usr/local/share/certs`、`/etc/pki/tls/certs`、`/etc/openssl/certs` のうち、最初に存在するディレクトリ。
4. 最後の手段として `AddCompiledInCerts()`。これは `dart` と `dartaotruntime` のバイナリ (つまりすべての `dart compile exe` の出力) に埋め込まれた Mozilla ルートバンドルを読み込みます。

変わったのはステップ 4 です。Dart 3.13.0 の changelog は「Dart Runtime」の項でこれを一行で述べています。組み込みのフォールバックルート証明書は "are no longer included" とのことです。SDK のコミットは [`7e5b075680`](https://github.com/dart-lang/sdk/commit/7e5b075680)、"Reland [standalone] Remove the fallback root certificates" で、5 月の最初の試みがリバートされた後、2026-06-01 にマージされました。この関数は 3.13 にも残っていますが、`runtime/bin/BUILD.gn` が `third_party/fallback_root_certificates` を取り込まなくなり、無条件に `DART_IO_ROOT_CERTS_DISABLED` を定義するため、`root_certificates_pem` は null になり、関数は何も追加せずに戻ります。

長年、このフォールバックは CA バンドルのないランタイムイメージを暗黙のうちに救っていました。コンパイル済みバイナリだけをコピーした `FROM scratch` ステージが動いたのは、バイナリ自身がルート証明書を持っていたからです。`ca-certificates` のない `debian:trixie-slim` ベースが動いたのも同じ理由です。3.13 では、これらのイメージは空の `X509_STORE` になり、BoringSSL はあらゆるチェーンの最初の証明書について発行元が不明だと報告します。

次の 2 点が、この問題を必要以上に分かりにくくしています。

- **`dart:stable` イメージ自体は問題ありません。** その Dockerfile は `ca-certificates` をインストールしており、マルチステージビルド用に用意された `/runtime/` ディレクトリには `/etc/ssl/certs` と `/usr/share/ca-certificates` が含まれ、シンボリックリンクが壊れないよう `--dereference` 付きでコピーされています。このエラーが出る場合、失敗しているプロセスは、ビルドに使ったイメージとは*別の*イメージで動いていることがほとんどです。#64060 では、ビルドには `dart:3.13.0` を使っていましたが、Pod は 5 年前の `docker:19.03.15` / `ubuntu:xenial` イメージで動いていました。
- **空の `/etc/ssl/certs` ディレクトリは、存在しないよりも悪い状態です。** ステップ 3 はディレクトリが存在するかどうかしか確認せず、中身があるかは確認しません。ディレクトリだけあって証明書が入っていないベースイメージもあり、その場合 VM は何事もなくそこから 0 個のルートを「読み込み」ます。

## 最小の再現例

HTTPS リクエストを 1 回行う Dart プログラムです。

```dart
// Dart 3.13.5, bin/server.dart
import 'dart:io';

Future<void> main() async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse('https://pub.dev/api/packages/http'));
    final response = await request.close();
    print('status: ${response.statusCode}');
    await response.drain<void>();
  } finally {
    client.close();
  }
}
```

そして、最終ステージに実行ファイルだけをコピーするマルチステージ Dockerfile です。手書きの Dockerfile や、公式のものより前に作られた CI テンプレートでよく見られる形です。

```dockerfile
# Dart 3.13.5 (dart:stable, September 2026)
FROM dart:stable AS build
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN dart compile exe bin/server.dart -o bin/server

FROM debian:trixie-slim
COPY --from=build /app/bin/server /app/bin/server
CMD ["/app/bin/server"]
```

`dart:3.12.2` でビルドすると、コンパイル済みのルート証明書のおかげで `status: 200` が出力されます。`dart:3.13.0` 以降でビルドすると、`debian:trixie-slim` には `ca-certificates` パッケージが含まれないため、上記の `HandshakeException` がスローされます。

## 修正方法の詳細

イメージに合う最初の選択肢を選んでください。どれも VM に本物のトラストストアを与えるもので、検証を無効にするものはありません。

### 1. `FROM scratch` ステージで公式の `/runtime/` コピーを維持する

これは [公式 `dart` イメージのドキュメント](https://hub.docker.com/_/dart) が推奨する構成で、すでに証明書を含んでいます。

```dockerfile
# Dart 3.13.5 (dart:stable)
FROM dart:stable AS build
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN dart compile exe bin/server.dart -o bin/server

FROM scratch
COPY --from=build /runtime/ /
COPY --from=build /app/bin/server /app/bin/
CMD ["/app/bin/server"]
```

最終ステージが `FROM scratch` で、`COPY` がバイナリだけの場合は、`/runtime/` の行を追加してください。証明書のほかに glibc ローダー、`libnss_dns`、`/etc/nsswitch.conf` も入るため、まだ遭遇していない DNS 解決の問題も同時に解消されます。

### 2. slim ランタイムイメージに `ca-certificates` をインストールする

`debian:*-slim` や `ubuntu:*` で実行している場合は、最終ステージでパッケージをインストールします。

```dockerfile
# Dart 3.13.5 AOT binary on debian:trixie-slim
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/bin/server /app/bin/server
CMD ["/app/bin/server"]
```

このパッケージのインストール後スクリプトが、VM が最初に確認するパスである `/etc/ssl/certs/ca-certificates.crt` を生成します。独自の証明書を追加する場合 (後述) を除き、別途 `update-ca-certificates` を呼ぶ必要はありません。RHEL、UBI、Fedora のイメージでも同等のパッケージは `ca-certificates` で、`/etc/pki/tls/certs/ca-bundle.crt` を生成します。これも一覧に含まれています。

Distroless でも動作します。`gcr.io/distroless/cc-debian12` は `/etc/ssl/certs/ca-certificates.crt` と、Dart AOT バイナリに必要な glibc を含んでいます。

### 3. 古いベースイメージを更新する

ランタイムイメージに `ca-certificates` はあるものの、何年も前のものである場合、そのバンドルは新しい CA がチェーンするルートよりも古くなっています。#64060 での実際の状況がこれでした。現行のベースイメージに移行することが修正になります。パッケージをその場で更新する (`apt-get update && apt-get install --only-upgrade ca-certificates`) 方法は、そのディストリビューションがまだ更新を公開している間だけ有効です。

### 4. `DART_VM_OPTIONS` で VM にバンドルを指定する

イメージには手を加えられないものの、ファイルをマウントしたり環境変数を設定したりできる場合 (Kubernetes の Pod スペック、マネージドランタイム) は、`--root-certs-file` を使います。JIT (`dart run`、`dart bin/server.dart`) では、通常の VM オプションです。

```bash
dart --root-certs-file=/certs/cacert.pem bin/server.dart
```

`dart compile exe` のバイナリは、VM オプションについては自身のコマンドラインを無視します。すべての引数があなたの `main` に渡されるためです。一方で `DART_VM_OPTIONS` は読み取ります。これはカンマ区切りのリストで、`main_impl.cc` が、スナップショットが追加された実行ファイルに対してのみ解析するもので、`--root-certs-file` は受け付けられるオプションの 1 つです。

```dockerfile
# Dart 3.13.5 AOT binary, CA bundle supplied explicitly
FROM debian:trixie-slim
COPY cacert.pem /certs/cacert.pem
COPY --from=build /app/bin/server /app/bin/server
ENV DART_VM_OPTIONS=--root-certs-file=/certs/cacert.pem
CMD ["/app/bin/server"]
```

`--root-certs-cache=<dir>` は、`c_rehash` 形式のハッシュ化された証明書ファイルのディレクトリに対して同じことを行います。どちらのオプションも、システムの探索を完全に置き換えます。ステップ 2 と 3 はスキップされ、指定したファイルがトラストストアのすべてになります。curl が公開している Mozilla 由来の [`cacert.pem`](https://curl.se/docs/caextract.html) のような、メンテナンスされているバンドルを使い、更新を続けてください。

### 5. コードからバンドルを読み込む

プログラム自体を自己完結にしたい場合は、起動時にデフォルトコンテキストへルートを追加します。`SecurityContext.defaultContext` は、コンテキストを渡さない場合に `HttpClient`、`package:http` の `IOClient`、その他ほとんどのクライアントが使うものです。

```dart
// Dart 3.13.5
import 'dart:io';

void main() {
  const bundle = '/certs/cacert.pem';
  if (File(bundle).existsSync()) {
    SecurityContext.defaultContext.setTrustedCertificates(bundle);
  }
  // ... start the server, create clients afterwards
}
```

スコープを完全に限定したい場合は、自分のバンドルだけを信頼するコンテキストを作り、クライアントに渡します。

```dart
// Dart 3.13.5, package:http 1.x
import 'dart:io';
import 'package:http/io_client.dart';

IOClient buildClient(List<int> pemBytes) {
  final context = SecurityContext(withTrustedRoots: false)
    ..setTrustedCertificatesBytes(pemBytes);
  return IOClient(HttpClient(context: context));
}
```

これは、1 つのサービスのためにプライベート CA をピン留めする用途に適した方法です。公開エンドポイント向けの一般的な修正としては、失ったフォールバックバンドルを作り直すだけで、しかもその更新責任があなたに移るため、選択肢 1 か 2 を優先してください。

## イメージにトラストストアがないことを確認する方法

`FROM scratch` や distroless のイメージにはシェルがないため、`docker run ... ls` は使えません。代わりに、停止したコンテナからパスをコピーして取り出します。

```bash
docker create --name probe my-dart-app:latest
docker cp probe:/etc/ssl/certs/ca-certificates.crt - | tar -tv
docker rm probe
```

`docker cp` が `Could not find the file` と言う場合は、上記の一覧にある他の 4 つのバンドルパスを確認してください。どれも存在せず、`/etc/ssl/certs` も存在しないか空であれば、原因が見つかったことになります。シェルのあるイメージなら、`ls -la /etc/ssl/certs | head` で十分です。

## 注意点と紛らわしいケース

- **`SSL_CERT_FILE` と `SSL_CERT_DIR` は効果がありません。** これらの環境変数は OpenSSL の慣習です。Dart VM は BoringSSL と独自にハードコードされたパス一覧を使うため、エクスポートしても影響しません。代わりに `DART_VM_OPTIONS=--root-certs-file=...` を使ってください。
- **企業の TLS インスペクションは別の問題です。** プロキシが社内 CA で通信を再署名している場合、Mozilla のフォールバックにその CA は含まれていなかったため、どの Dart バージョンでも同じメッセージが出ます。CA をシステムストアに追加する (`COPY corp-root.crt /usr/local/share/ca-certificates/` の後に `update-ca-certificates`) か、`setTrustedCertificates` で読み込んでください。
- **自己署名や不完全なチェーンも同じメッセージで失敗します。** `https://pub.dev` は動くのに特定の 1 つのホストだけが失敗する場合、そのサーバーが中間証明書を送信していない可能性が高いです。サーバーを修正してください。`badCertificateCallback: (_, _, _) => true` は追加しないでください。クライアントが通信するすべての相手に対して検証が無効になってしまいます。
- **`dart pub get` も失敗します。** SDK の zip を `ca-certificates` のないベースに展開するカスタムイメージの場合です。この場合はビルドステージにパッケージが必要で、修正方法は同じです。
- **Alpine は逃げ道になりません。** `dart compile exe` の出力は glibc にリンクされるため、musl イメージでは TLS に到達する前に失敗します。glibc ベースを使い続けてください。
- **Flutter のモバイルアプリは影響を受けません。** Android は `/system/etc/security/cacerts` を直接読み込み、フォールバックを使ったことがなく、iOS は Security フレームワークで信頼を評価します。この変更が影響するのは Linux 上のスタンドアロン VM、つまり `dart compile exe` でコンパイルしたサーバー、CLI、バックエンドです。

## 関連記事

- 同じコンテナ化された CI が pub の警告も出力する場合、[pub.dev の advisories デコードエラー](/ja/2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev/) は別の、無害なメッセージです。
- 長時間稼働するコンテナの外で動く Dart バックエンドについては、[Firebase Cloud Functions の実験的な Dart サポート](/ja/2026/05/dart-cloud-functions-firebase-experimental/) も、Linux コンテナ内のコンパイル済み Dart バイナリになるため、同じ方法でベースイメージを確認してください。
- 小さなランタイムステージのトレードオフは .NET 側でもよく似ています。[.NET 11 コンテナイメージにおけるフレームワーク依存、自己完結型、Native AOT の比較](/ja/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) を参照してください。
- 失敗している呼び出しが gRPC の場合は、[コンテナ内の gRPC の落とし穴](/ja/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) が、クライアント側からは似て見える TLS と HTTP/2 の問題を扱っています。

## 参考資料

- [dart-lang/sdk#64060: CERTIFICATE_VERIFY_FAILED on dart:3.13.0 (dart:stable) image](https://github.com/dart-lang/sdk/issues/64060)
- [Dart SDK CHANGELOG, 3.13.0 の「Dart Runtime」セクション](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Commit 7e5b075680: Reland "[standalone] Remove the fallback root certificates."](https://github.com/dart-lang/sdk/commit/7e5b075680)
- [`runtime/bin/security_context_linux.cc` (3.13.5)](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/security_context_linux.cc)
- [`runtime/bin/main_impl.cc` と `main_options.cc` (3.13.5、`DART_VM_OPTIONS` の処理)](https://github.com/dart-lang/sdk/blob/3.13.5/runtime/bin/main_options.cc)
- [dart-lang/dart-docker `stable/trixie/Dockerfile`](https://github.com/dart-lang/dart-docker/blob/main/stable/trixie/Dockerfile)
- [`SecurityContext` API リファレンス](https://api.dart.dev/dart-io/SecurityContext-class.html)
