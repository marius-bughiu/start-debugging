---
title: "Android スマートフォンを Streamlabs のウェブカメラとして使う"
description: "DroidCam を使って、古い Android スマートフォンを Streamlabs OBS 用のウェブカメラとして活用するセットアップ手順をステップバイステップで紹介します。"
pubDate: 2019-04-30
updatedDate: 2020-08-06
tags:
  - "android"
lang: "ja"
translationOf: "2019/04/use-your-android-phone-as-a-webcam-for-streamlabs"
translatedBy: "claude"
translationDate: 2026-05-01
---
配信用のウェブカメラが必要ですか？家に転がっている、壊れた / 古くなったスマートフォンを使ってみてはいかがでしょう。

ほとんどのスマートフォンは、一般的なウェブカメラよりも高い解像度と良い画質で写真や動画を撮ることができます。これは、配信時にウェブカメラの代わりとして理想的です。とくに、すでに使われていないスマートフォンが手元にあるならなおさらです。

最近、私の手元に画面が壊れた Google Pixel 2 XL が残りました。長い話を短く言うと、画面を割って、交換し、8 か月後に交換した画面が壊れたのです。コストと保証がないことを踏まえ、もう画面交換はしないと決めました。結果として、壊れたスマートフォンと、完璧に動作する素晴らしいカメラだけが残ったわけです。

それでは始めましょう。Android スマートフォンをウェブカメラとして使うには、以下の 2 つが必要です。

-   Android 用の [DroidCam Wireless Webcam](https://play.google.com/store/apps/details?id=com.dev47apps.droidcam)
-   Windows または Linux 用のクライアントアプリ。[こちらからダウンロード](http://www.dev47apps.com/) できます

まず、Android スマートフォンにアプリをダウンロードしてインストールします。インストール後、セットアップウィザードを進め、必要な権限 (オーディオとビデオの録音 / 録画) をアプリに付与すれば完了です。アプリは、ストリーミングしている IP アドレスとポートなどの情報を表示します。次のステップで使うので、控えておいてください。

![デスクトップクライアントの接続に使う Wi-Fi の IP アドレスとポートを表示する Android の DroidCam。](/wp-content/uploads/2019/04/image-7.png)

次に、Windows または Linux 用のクライアントをダウンロードしてインストールします。インストール後にアプリを起動し、Android アプリで表示されている IP アドレスとポート番号をそのまま入力します。

![端末の IP とポートが入力され、Video と Audio が有効になった DroidCam Client の Wi-Fi 接続画面。](/wp-content/uploads/2019/04/image-8.png)

準備ができたら Start を押します。これで真新しいウェブカメラの完成です！

![接続したスマートフォンのカメラ映像を表示する DroidCam Client。](/wp-content/uploads/2019/04/image-9.png)

最後のステップは、ビデオソースを Streamlabs に追加することです。Streamlabs OBS を開き、+ をクリックして新しい Source を追加します。

![Video Capture Device に下線が付いた Streamlabs の Add Source 画面。](/wp-content/uploads/2019/04/image-5-1024x555.png)

開いたポップアップで Video Capture Device を選択し、Add Source をクリックします。次の画面で Add New Source をクリックします。これでデバイスの設定をいじれるようになります。まず Device のドロップダウンから DroidCam を選択してください。私の場合は DroidCam Source という名称になっています。続いて、希望する結果になるよう各種設定を調整します。私の場合は、既定値のままで問題ありませんでした。終わったら Done をクリックします。

![DroidCam Source 3 を選択し、カメラのプレビューを表示した Streamlabs の Video Capture Device 設定。](/wp-content/uploads/2019/04/image-10.png)

これで、ビデオソースをシーン上でドラッグしたり、好きなサイズに変えたりできます。準備ができたら配信を開始できます。

![デスクトップキャプチャの右下にスマートフォンのカメラ映像を小さく重ねた Streamlabs のシーン。](/wp-content/uploads/2019/04/image-11-1024x555.png)

## ヒント

スマートフォンをウェブカメラとして使うときの問題の 1 つは、安定した位置 (できれば一定の高さと角度) に固定することです。これはスマートフォン用三脚で解決できます。

私はニーズに合う中で最安だった Huawei AF14 を選びました。三脚を入手したら、自分に合った角度と、目線に近い高さに設置してください。
