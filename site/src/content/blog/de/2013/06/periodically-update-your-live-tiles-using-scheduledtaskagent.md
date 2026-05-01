---
title: "Live Tiles regelmäßig mit einem ScheduledTaskAgent aktualisieren"
description: "Verwenden Sie einen ScheduledTaskAgent, um die Live Tiles Ihres Windows Phone regelmäßig aus einem RSS-Feed zu aktualisieren."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "de"
translationOf: "2013/06/periodically-update-your-live-tiles-using-scheduledtaskagent"
translatedBy: "claude"
translationDate: 2026-05-01
---
In einem früheren Beitrag habe ich gezeigt, [wie Sie Wide Tiles für Ihre Windows Phone 7-Anwendung erstellen](/de/2013/05/creating-wide-tiles-for-your-windows-phone-7-app/). Jetzt ist es an der Zeit, sie mit Leben zu füllen. Am einfachsten geht das mit einem ScheduledTaskAgent. Fügen Sie dazu Ihrer Solution ein neues Projekt hinzu und wählen Sie aus den Projektvorlagen 'Windows Phone Scheduled Task Agent'.

Bevor wir weitermachen: Fügen Sie dieses neue (Task-Agent-)Projekt als Referenz im Hauptprojekt der Anwendung hinzu.

Dadurch entsteht eine Klasse 'ScheduledAgent', die von 'ScheduledTaskAgent' erbt. Konstruktor und Exception-Handler können Sie unverändert lassen. Uns interessiert die Methode 'OnInvoke'. Sie wird, solange der Agent läuft, regelmäßig aufgerufen.

Hier aktualisieren wir unser Live Tile. Sagen wir, wir aktualisieren es aus einem RSS-Feed. Zuerst müssen wir den Feed herunterladen.

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

Nach dem Download deserialisieren Sie ihn, nehmen das erste (neueste) Item und nutzen Titel und Bild, um Ihr Live Tile zu aktualisieren.

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

Achten Sie darauf, wo ich NotifyComplete() aufrufe. Diese Methode gibt alle vom Agent verwendeten Ressourcen frei. Es ist wichtig, sie aufzurufen, denn sonst endet die Task nie und startet daher auch nie wieder. Außerdem ist es sehr wichtig, sie erst aufzurufen, wenn alles erledigt ist - in diesem Fall im DownloadStringCompleted-Event, nachdem die Live Tiles aktualisiert wurden.

Es bleibt nur noch eines zu tun: die geplante Task zu registrieren. Das machen wir im Event Application\_Launching (in App.xaml.cs).

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
