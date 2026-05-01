---
title: "ScheduledTaskAgent を使って live tiles を定期的に更新する"
description: "ScheduledTaskAgent を使い、RSS フィードから Windows Phone の live tiles を定期的に更新する方法を解説します。"
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "ja"
translationOf: "2013/06/periodically-update-your-live-tiles-using-scheduledtaskagent"
translatedBy: "claude"
translationDate: 2026-05-01
---
以前の記事で [Windows Phone 7 アプリ用に wide tiles を作成する方法](/ja/2013/05/creating-wide-tiles-for-your-windows-phone-7-app/) を紹介しました。今度はそれらに命を吹き込みます。もっとも手軽な方法は ScheduledTaskAgent を使うことです。作成するには、ソリューションに新しいプロジェクトを追加し、プロジェクトテンプレートから 'Windows Phone Scheduled Task Agent' を選んでください。

先に進む前に、この新しい (task agent の) プロジェクトをアプリ本体のプロジェクトに参照として追加してください。

これにより 'ScheduledTaskAgent' を継承する 'ScheduledAgent' というクラスが作成されます。クラスのコンストラクターと例外ハンドラーはそのままで構いません。注目したいメソッドは 'OnInvoke' です。これが、agent が動作している間に定期的に呼び出されるメソッドです。

ここで live tile を更新します。RSS フィードから更新するとしましょう。最初にフィードをダウンロードする必要があります。

```cs
protected override void OnInvoke(ScheduledTask task)
{
    WebClient client = new WebClient();
    client.DownloadStringCompleted += (s, e) =>
        {
            DownloadStringCompleted(s, e);
            NotifyComplete();
        };
    client.DownloadStringAsync(new Uri("http://blogs.windows.com/windows_phone/b/windowsphone/rss.aspx"));
}
```

ダウンロードできたらデシリアライズし、最初 (最新) のアイテムを取り、そのタイトルと画像を使って live tile を更新します。

```cs
private void DownloadStringCompleted(object sender, DownloadStringCompletedEventArgs e)
{
    if (e.Error == null)
    {
        StringReader stringReader = new StringReader(e.Result);
        XmlReader xmlReader = XmlReader.Create(stringReader);
        SyndicationFeed feed = SyndicationFeed.Load(xmlReader);

        var latestArticle = feed.Items.FirstOrDefault();
        var tile = ShellTile.ActiveTiles.FirstOrDefault();
        if (tile != null)
        {
            var tileData = new FlipTileData();
            tileData.Title = "Windows Phone Blog";

            var content = latestArticle.Title.Text + " - " + latestArticle.Summary.Text;
            var image = latestArticle.Links.FirstOrDefault(l => l.MediaType != null && l.MediaType.Contains("image")).Uri;

            tileData.BackContent = content;
            tileData.BackgroundImage = image;

            tileData.WideBackContent = content;
            tileData.WideBackgroundImage = image;
            tile.Update(tileData);
        }
    }
}
```

NotifyComplete() を呼ぶ場所に注意してください。このメソッドは agent が使ったすべてのリソースを解放します。呼び出すことが重要です。呼ばないと task が終わらず、次回も起動しません。また、すべての処理が終わってから呼び出すことも非常に重要です。今回の例では、live tiles を更新したあとの DownloadStringCompleted イベント内です。

残りの作業は、スケジュールされた task の登録だけです。これは Application\_Launching イベント (App.xaml.cs にあります) で行います。

```cs
private void Application_Launching(object sender, LaunchingEventArgs e)
{
    var taskName = "WindowsPhoneBlogSTA";
    PeriodicTask periodicTask = ScheduledActionService.Find(taskName) as PeriodicTask;
    if (periodicTask != null)
        ScheduledActionService.Remove(taskName);

    periodicTask = new PeriodicTask(taskName) { Description = "Periodic task to update the tile of <your app>." };
    try
    {
        ScheduledActionService.Add(periodicTask);
        #if DEBUG
            ScheduledActionService.LaunchForTest(taskName, TimeSpan.FromSeconds(30));
        #endif
    }
    catch (InvalidOperationException) { }
}
```
