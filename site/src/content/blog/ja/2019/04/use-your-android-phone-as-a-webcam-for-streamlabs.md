---
title: "Android スマートフォンを Streamlabs のウェブカメラとして使う"
description: "Android を Windows の Streamlabs Desktop でウェブカメラにする方法。現在の DroidCam ダウンロード先と、旧版の画面例を区別して紹介します。"
pubDate: 2019-04-30
updatedDate: 2026-11-02
tags:
  - "android"
lang: "ja"
translationOf: "2019/04/use-your-android-phone-as-a-webcam-for-streamlabs"
translatedBy: "claude"
translationDate: 2026-05-01
---

カメラが動作する Android 端末は、Streamlabs のシーンに映像を供給できます。画質は端末、照明、接続、設定に左右されるため、古い端末が専用ウェブカメラより優れるとは限りません。

## 対応するアプリとクライアントを選ぶ

以下の画像は **Windows 上の DroidCam Classic と旧 Streamlabs OBS の画面**です。元の Android パッケージ `com.dev47apps.droidcam` は、2026年11月2日に米国・ルーマニア・ドイツの Google Play 地域パラメーターで確認した URL では 404 でした。世界中で削除されたことや、すべての既存アカウント・端末での利用可否までは示しません。

新規導入向けに、現在の [droidcam.app](https://droidcam.app/) は Dev47Apps の [DroidCam Webcam & OBS Camera](https://play.google.com/store/apps/details?id=com.dev47apps.obsdroidcam)、パッケージ `com.dev47apps.obsdroidcam` を案内しています。これは Classic のリンク先変更ではなく別の Android アプリです。[公式 FAQ](https://droidcam.app/help/) も新旧の Android アプリとクライアントを区別しています。対応する組み合わせを使ってください。Classic の画像は新しい UI の操作説明ではありません。

この手順の対象は **Windows** です。[現在の DroidCam クライアント](https://droidcam.app/windows/) は Windows 10/11 に対応しますが、使用する Streamlabs も[独自のシステム要件](https://streamlabs.com/content-hub/post/streamlabs-desktop-system-requirements)を満たす必要があります。DroidCam に Linux クライアントがあっても、Streamlabs Desktop の Linux 向け手順にはなりません。macOS や OBS Studio プラグインの構成は別であり、OBS Studio のプラグインと Streamlabs のソースを同一視しないでください。

## 現在の Windows 向け手順

1. 上記の確認済みリンクから現在の Dev47Apps Android アプリを入れ、カメラ権限を許可します。端末の音声を使う場合だけマイク権限も許可します。
2. 対応する Windows クライアントを[公式ダウンロード・セットアップページ](https://droidcam.app/windows/)から入れます。
3. 端末と PC を同じネットワークに接続してアプリを開きます。クライアントで **Add > DroidCam** を選び、デバイス一覧を更新して端末を接続します。USB や検出の問題は公式ヘルプを参照します。
4. ドライバー導入後に Streamlabs Desktop を開き直します。[ソース追加ガイド](https://streamlabs.com/content-hub/post/quick-start-guide-setting-up-streamlabs-desktop-for-streaming)に従って **Video Capture Device** を追加し、クライアントが公開するカメラを選びます。現在の Windows ガイドでは **DroidCam Video**、旧 Classic では **DroidCam Source 2/3** と表示される場合があります。
5. プレビューと配置を調整し、短いテスト録画を行います。音声は別途確認してください。映像が表示されても、マイクの経路が正しいとは限りません。

## Classic の Windows 手順：保存された画面例

以下は対応する Classic アプリとクライアントを既に持っている人向けの旧画面です。[Classic の接続手順](https://www.dev47apps.com/droidcam/connect/)では端末と PC を同じネットワークに置き、端末に表示された Wi-Fi IP とポートをクライアントに入力します。[Classic Windows クライアントの公式ページ](https://www.dev47apps.com/droidcam/windows/)には引き続き導入情報があります。

Classic Android アプリに接続先アドレスが表示されます。

![デスクトップクライアントの接続に使う Wi-Fi の IP アドレスとポートを表示する Android の DroidCam。](/wp-content/uploads/2019/04/image-7.png)

そのアドレスとポートを Classic Windows クライアントに入力します。

![端末の IP とポートが入力され、Video と Audio が有効になった DroidCam Client の Wi-Fi 接続画面。](/wp-content/uploads/2019/04/image-8.png)

接続を開始してプレビューを確認します。

![接続したスマートフォンのカメラ映像を表示する DroidCam Client。](/wp-content/uploads/2019/04/image-9.png)

旧 Streamlabs UI で Video Capture Device ソースを追加します。

![Video Capture Device に下線が付いた Streamlabs の Add Source 画面。](/wp-content/uploads/2019/04/image-5-1024x555.png)

この環境では DroidCam Source 3 を使いました。自分のクライアントが公開するデバイスを選びます。

![DroidCam Source 3 を選択し、カメラのプレビューを表示した Streamlabs の Video Capture Device 設定。](/wp-content/uploads/2019/04/image-10.png)

シーン内でカメラ映像の位置と大きさを調整します。

![デスクトップキャプチャの右下にスマートフォンのカメラ映像を小さく重ねた Streamlabs のシーン。](/wp-content/uploads/2019/04/image-11-1024x555.png)

目の高さに近い位置で端末を固定すると構図を調整しやすくなります。端末に合うホルダーを選んでください。以前の Huawei AF14 への言及は個人的な購入記録であり、現在の価格や在庫を踏まえた推奨ではありません。

別のシーン要素については [Streamlabs の投票機能の記事](/ja/2020/08/polls-for-streamlabs-interact-with-your-viewers/)も参照できます。

**2026年11月2日訂正:** Classic と現行アプリを区別し、利用できない旧ストアリンクを明示的な現行導入案内へ置き換え、Streamlabs の手順を Windows に限定しました。リンクと公式手順は確認しましたが、この更新で端末と Windows の実機試験は行っていません。
