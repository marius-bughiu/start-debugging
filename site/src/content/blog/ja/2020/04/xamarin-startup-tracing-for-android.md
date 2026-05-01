---
title: "Xamarin の Android 向け Startup Tracing"
description: "Xamarin Android アプリの起動時間を最大 48% 短縮できる startup tracing を使い、起動時に必要なコードだけを AOT コンパイルします。"
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "android"
  - "xamarin"
lang: "ja"
translationOf: "2020/04/xamarin-startup-tracing-for-android"
translatedBy: "claude"
translationDate: 2026-05-01
---
アプリの起動時間は重要です。ユーザーがそのアプリのパフォーマンスについて最初に受け取る印象だからです。使うたびにアプリのロードに 10 秒かかるなら、何を約束されても意味はありません。「実は動いていないのでは」と思って、ユーザーがアンインストールしてしまうこともあります。Xamarin Android では、これは長らくホットな話題でした。そこでチームは、startup tracing を導入して、この問題により積極的に取り組むことにしました。

## startup tracing とは

要するに、アセンブリの一部を just-in-time (JIT) ではなく ahead-of-time (AOT) でコンパイルし、コード実行時のオーバーヘッドを減らす代わりに、APK サイズを増やすという仕組みです。

具体的には、startup tracing はアプリのカスタムプロファイルに基づいて、起動時にアプリが必要とするものだけを AOT 化します。そのため、APK の増加は最小限に抑えつつ、効果は最大化されます。

Xamarin チームが共有しているいくつかの数値です。

| 種類 | 起動時間 | APK サイズ |
| --- | --- | --- |
| Normal | 2914 ms | 16.1 MB |
| AOT | 1180 ms (-59%) | 34.6 MB (+115%) |
| Startup Tracing | 1518 ms (-48%) | 20.1 MB (+25%) |

## startup tracing を有効にする

有効にするのは簡単です。Xamarin Android プロジェクトの設定 (右クリック > Properties) を開き、下の画像のように "Code Generation and Runtime" の "Enable Startup Tracing" にチェックを入れるだけです。

![](/wp-content/uploads/2020/04/Annotation-2020-04-04-122649-3.png)
