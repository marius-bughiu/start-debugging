---
title: "Xamarin Forms 3 へのアップグレード"
description: "よく出会うビルドエラーとその対処法を含む、Xamarin Forms 3 へのアップグレードのクイックガイド。"
pubDate: 2018-04-07
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ja"
translationOf: "2018/04/upgrading-xamarin-forms-3"
translatedBy: "claude"
translationDate: 2026-05-01
---
Xamarin のメジャーバージョン間のアップグレードは、何かを壊したり、奇妙なエラーでプロジェクトがビルドできなくなったりしがちです。素直な開発者ほどこれらのエラーを真に受け、理解しようとし、直そうとし、うまくいかなければ Google で検索します。ですが、多くの場合、解決策は Visual Studio を閉じて開き直し、ソリューションをクリーンビルドすることです。さて、Xamarin Forms 3 を見ていきましょう (ただし、これは pre-release 版なので、正式リリースまでには解消されているかもしれません)。

既存のプロジェクトを開くか、.NET Standard を使った新しい Master Detail プロジェクトを作成します。プロジェクトをビルドして動作することを確認してください。次に、ソリューションの NuGet パッケージを管理します。私のように pre-release 版を使う場合は "Include prerelease" にチェックを入れてください。

すべてのパッケージを選択して Update します。ここでビルドを試すと、GenerateJavaStubs の失敗や XamlGTask が XamlFiles パラメーターに対応していない、といったエラーが出るはずです。無視してください。Visual Studio を閉じ (VS は何らかのタスクがキャンセルされたというエラーを出すかもしれませんが、それも無視)、もう一度 VS を開き、ソリューションをクリーンしてリビルドします -- そう、真のデベロッパーらしく。

その後、新規プロジェクトで Android 向けにビルドしている場合は、Java max heap size のエラーに遭遇します。

Android プロジェクトの Properties に行き、Android Options を選び、下にある Advanced をクリックします。Java Max Heap Size の項目に "1G" と入力してください。これを新規プロジェクトのデフォルトにしてくれるのはいつになることやら……。

もう一度ビルドすれば、できあがり！動くはずです。
