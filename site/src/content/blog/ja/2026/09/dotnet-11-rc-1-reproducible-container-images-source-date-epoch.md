---
title: ".NET 11 RC 1 で dotnet publish のコンテナーイメージが再現可能になります"
description: ".NET 11 RC 1 の SDK は、コンテナーイメージの発行時に SOURCE_DATE_EPOCH を尊重し、レイヤーの tar ヘッダーからプロセス ID を取り除き、レジストリにマニフェストが既に存在する場合は blob のアップロードを省略します。同じコミットからは同じダイジェストが得られます。"
pubDate: 2026-09-12
tags:
  - "dotnet-11"
  - "containers"
  - "sdk"
  - "dotnet"
lang: "ja"
translationOf: "2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch"
translatedBy: "claude"
translationDate: 2026-09-12
---

.NET 10 で同じコミットを `dotnet publish /t:PublishContainer` で 2 回発行すると、異なるイメージダイジェストが 2 つ得られます。コードは同一ですが、SDK がすべてのレイヤーエントリとイメージ構成に現在時刻を刻み込んでいたためです。さらに、すべてのレイヤー tar にプロセス ID も刻み込んでいました。これではレジストリは重複排除できず、タグを監視している GitOps コントローラーは新しいリリースと認識してしまいます。2026 年 9 月 8 日にリリースされた [.NET 11 RC 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) は、SDK 組み込みのコンテナーツールでこの両方を修正しています ([dotnet/sdk#55836](https://github.com/dotnet/sdk/pull/55836))。

## 時刻がダイジェストに漏れ込んでいた 4 か所

[元の PR](https://github.com/dotnet/sdk/pull/55689) には次の 4 か所が挙げられています。

- レイヤー内のすべての `PaxTarEntry` は、更新日時が既定で `DateTime.UtcNow` になり、ファイルごとに個別に取得されていました。
- イメージ構成は `created` のために `DateTime.UtcNow` を取得し、生成される履歴エントリのためにもう一度取得していました。
- `org.opencontainers.image.created` と `org.opencontainers.artifact.created` のラベルは、targets ファイル内の `UtcNow` から設定されていました。
- `TarWriter` は各 pax 拡張ヘッダーに `./PaxHeaders.<process id>/.` という名前を付けるため、pid がすべてのレイヤーに入り込んでいました。

内容がバイト単位で同一でも、pid だけでレイヤーダイジェストが変わっていました。レイヤーの差分はわずか 13 バイトで、そのすべてがこのヘッダー名によるものでした。

## SOURCE_DATE_EPOCH によるオプトイン

RC 1 は [reproducible-builds の規約](https://reproducible-builds.org/docs/source-date-epoch/)に従います。`SOURCE_DATE_EPOCH` MSBuild プロパティ、または MSBuild が自動的に読み取る同名の環境変数が、一度だけ解析されて単一のタイムスタンプになります。その値が、すべての tar エントリ、構成の `created` フィールド、履歴エントリ、そして両方の OCI ラベルに使われます。

```bash
dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerRegistry=registry.example.com \
  -p:SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
```

コミットのタイムスタンプを使えば、ダイジェストはコミットが変わったときにだけ変わります。RC 1 SDK (`11.0.100-rc.1.26425.128`) で、コンソールアプリを tarball に 3 回発行して確認しました。

```bash
pub() { dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerArchiveOutputPath=./$1.tar.gz "${@:2}"; }

pub a -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub b -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub c                                   # config 5f24aace..., app layer 2f4f68c1...
```

実行 `a` と `b` はバイト単位で同一で、構成の `created` フィールドは `2025-09-12T00:00:00.0000000Z` になります。実行 `c` は引き続き実時刻を使うため、再現性はオプトインです。値の形式が不正な場合、負の値の場合、範囲外の場合、SDK は現在時刻にフォールバックします。ビルドは失敗しません。

アップグレード前に知っておくべき副作用が 2 つあります。ディレクトリの列挙順序はファイルシステムに依存するため、レイヤーライターはエントリをコンテナーパスで並べ替えるようになりました。また、pax ヘッダー名は常に定数 `./PaxHeaders/.` になります。どちらも `SOURCE_DATE_EPOCH` を指定しなくてもすべての発行に適用されるため、RC 1 に移行した時点でダイジェストが一度変わります。

## レジストリに既にあるもののアップロードを省略する

関連する変更 ([dotnet/sdk#55838](https://github.com/dotnet/sdk/pull/55838)) は、これを土台にしています。プッシュの前に、SDK は計算したマニフェストダイジェストに対して `HEAD` リクエストを送信します。レジストリに既に存在する場合、SDK はレイヤーと構成のアップロードを省略しつつ、要求されたすべてのタグは適用し、`Manifest '...' already exists in repository '...'` とログに出力します。CI ジョブの再試行や、変更のないコミットへの 2 つ目のタグ付けは、数回のメタデータ呼び出しで済むようになります。

RC 1 の targets では、これが既定で有効です。`ContainerPushNoCache` の既定値は `false` です。レジストリがマニフェストの存在を誤って報告する場合は、このチェックを無効にします。

```bash
dotnet publish /t:PublishContainer -p:ContainerPushNoCache=true
```

ダイジェストを先に計算する必要があるため、イメージは引き続きローカルでビルドされます。つまり節約できるのは転送であり、ビルド時間ではありません。また、効果があるのはダイジェストが安定している場合だけです。2 つの PR が同時にマージされたのはそのためです。

長年の回避策が不要になる RC 1 の別の変更については、[`Process` のシグナルと終了ステータス](/ja/2026/09/dotnet-11-rc-1-process-signal-exit-status/)を参照してください。SDK の変更の全リストは [RC 1 SDK リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/sdk.md)にあります。
