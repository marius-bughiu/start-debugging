---
title: "AdMob が Windows Phone アプリをクラッシュさせる。代替手段は？"
description: "AdMob のせいで Windows Phone アプリが WebBrowser.InvokeScript 経由でクラッシュしていました。本記事では stack trace と原因、InnerActive のような代替広告ネットワークを紹介します。"
pubDate: 2012-09-16
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "ja"
translationOf: "2012/09/admob-crashing-windows-phone-apps-what-is-the-alternative"
translatedBy: "claude"
translationDate: 2026-05-01
---
少し前、global publisher ではなく devcenter のデベロッパーアカウントで初めてアプリを公開したのですが、ほんの数日後 (というより数週間後) に、アプリのクラッシュレポートが届くようになりました。原因を突き止められないかと stack trace データをダウンロードしましたが、運が悪く、原因についてはほとんど何も得られませんでした。分かっているのは、ブラウザーが絡んでいるということだけです。

私の stack trace は次のとおりです。

```plaintext
Frame    Image             Function                                                   Offset
0        coredll.dll       xxx_RaiseException                                         19
1        mscoree3_7.dll                                                               436172
2        mscoree3_7.dll                                                               383681
3        mscoree3_7.dll                                                               540620
4                          TransitionStub                                             0
5                          Microsoft.Phone.Controls.NativeMethods.ValidateHResult     236
6                          Microsoft.Phone.Controls.WebBrowserInterop.InvokeScript    128
7                          Microsoft.Phone.Controls.WebBrowser.InvokeScript           84
8                          .__c__DisplayClass36._RunScripts_b__34                     228
9        mscoree3_7.dll                                                               428848
10       mscoree3_7.dll                                                               222523
11       mscoree3_7.dll                                                               221143
12                         System.Reflection.RuntimeMethodInfo.InternalInvoke         112
13                         System.Reflection.RuntimeMethodInfo.InternalInvoke         1556
14                         System.Reflection.MethodBase.Invoke                        104
15                         System.Delegate.DynamicInvokeOne                           564
16                         System.MulticastDelegate.DynamicInvokeImpl                 84
17                         System.Windows.Threading.DispatcherOperation.Invoke        80
18                         System.Windows.Threading.Dispatcher.Dispatch               404
19                         System.Windows.Threading.Dispatcher.OnInvoke               56
```

そこで次の疑問: 私のアプリで web browser を使っているのはどこか？ 答え: ありません。広告部分以外には。そして登場するのが AdMob です。少し検索してみると、この問題を抱えているのは私だけではなく、よく似た stack trace を持つ開発者がたくさんいて、皆 AdMob で広告を表示していることが分かりました。

AdMob の Google グループでも、この種の issue やクラッシュで溢れているのに、解決のための動きはありません。回避策はあるにはあります -- unhandled exception を handled としてマークしてアプリのクラッシュを防ぐ、など -- しかしそれをすると広告がクリック不可になり、望ましくありません。

そこで代替を探し始め、しばらくして InnerActive にたどり着きました。多くの開発者は Microsoft の Pub Center と AdMob の代替としてこれを推しているようで、HalfBrick や ZeptoLab のような有名パブリッシャーとのよい提携も見受けられます。試してみます。

ドキュメントとサポートされる広告の種類は少し見たところで、悪くなさそうです (少なくとも AdMob よりはずっと良さそう)。自分のアプリのひとつに広告を組み込んでみて、どうだったか報告します。
