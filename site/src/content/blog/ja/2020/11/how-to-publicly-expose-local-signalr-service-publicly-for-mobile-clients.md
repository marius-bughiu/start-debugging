---
title: "ngrok を使って、モバイルクライアント向けにローカルの SignalR サービスを公開する方法"
description: "ngrok を使ってローカルの SignalR サービスを公開し、モバイルクライアントがネットワーク設定や SSL の回避策なしで接続できるようにします。"
pubDate: 2020-11-04
tags:
  - "csharp"
  - "signalr"
  - "xamarin-forms"
lang: "ja"
translationOf: "2020/11/how-to-publicly-expose-local-signalr-service-publicly-for-mobile-clients"
translatedBy: "claude"
translationDate: 2026-05-01
---
モバイルクライアントを扱うとき、開発マシンと同じネットワークに置くのは必ずしも簡単ではありません。仮にできたとしても `localhost` の意味が変わるため、IP を使ったり、バインディングを変えたり、SSL を無効化したり、自己署名証明書を信頼させたりと、要するに大変です。

そこで [ngrok](https://ngrok.com) の出番です。

ngrok は、開発マシン上の特定のポートへすべてのリクエストをルーティングする安全な公開プロキシを作成できます。無料プランでは、ランダムな URL とポートで HTTP/TCP トンネルを 1 プロセスのみ、最大 40 接続/分まで利用できます。多くの方には十分でしょう。予約ドメインやカスタムサブドメイン、上限の引き上げが必要なら、有料プランも用意されています。

## さっそく始めましょう

まずは ngrok でアカウントを登録し、クライアントをダウンロードして任意の場所に展開します。続いて [Setup & Installation guide](https://ngrok.com/docs/getting-started/) に従い、`ngrok authtoken` コマンドを実行して認証します。

次に Web アプリケーションを起動し、その URL を確認します。私のものは `https://localhost:44312/` なので、ポート 44312 を https で転送したいということです。認証に使ったのと同じ `cmd` ウィンドウで、`` ngrok http `https://localhost:44312/` `` を実行します。もちろん `https://localhost:44312/` の部分はご自身のアプリの URL に置き換えてください。これでプロキシが起動し、アクセス可能な公開 URL が表示されます。

![Free プランで公開プロキシを動かしている ngrok](/wp-content/uploads/2020/10/image-1.png)

HTTPS を使っていない場合は、もっと短い `ngrok http 44312` でも構いません。

400 Bad Request -- Invalid Hostname が返る場合、誰かが `Host` ヘッダーを検証しようとしていて一致しないために失敗しています。ngrok は既定ではすべてを変更せず Web サーバーにそのまま渡すためです。`Host` ヘッダーを書き換えるには `-host-header=rewrite` スイッチを使います。

私のケースでは、ASP.NET Core + IIS Express を使っているため、完全なコマンドは次のようになります。

`ngrok http -host-header=rewrite https://localhost:44312`

上のウィンドウから URL をコピーし、クライアントで更新してください。Free プランでは ngrok を起動・停止するたびに URL が変わる点に注意してください。

## 試してみる

オリジナルの Xamarin Forms SignalR Chat サンプルをクローンし (GitHub リポジトリは現在公開されていません)、.Web プロジェクトを起動して上記のように `ngrok` で公開すれば、簡単に試せます。その後、`appsettings.json` の `ChatHubUrl` を `ngrok` が生成した URL に置き換えてください。
