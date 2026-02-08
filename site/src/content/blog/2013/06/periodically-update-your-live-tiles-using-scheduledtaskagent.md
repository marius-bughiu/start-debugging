---
title: "Periodically update your live tiles using ScheduledTaskAgent"
description: "Use a ScheduledTaskAgent to periodically update your Windows Phone live tiles from an RSS feed."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
---
I’ve covered in a previous post [how to create wide tiles for your Windows Phone 7 application](/2013/05/creating-wide-tiles-for-your-windows-phone-7-app/). Now it’s time to bring them to life. The easiest way to do so is by using a ScheduledTaskAgent. To create one go ahead and add a new project to your solution and from the project templates list choose ‘Windows Phone Scheduled Task Agent’.

Before we go any further – go ahead and add this new (task agent) project as a reference in the main application project.

This will create for you a class called ‘ScheduledAgent’ which inherits ‘ScheduledTaskAgent’. You can leave the constructor of the class and the exception handler as they are. The method that interests us is ‘OnInvoke’. This is the method that will be called for us periodically for as long as the agent is running.

This is the method in which we will update our live tile. Let’s say we update our tile from a RSS feed. So the first thing we need to do is download our feed.

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

Once downloaded, deserialize it, take the first (latest) item and use the title and image to update your live tile.

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

Pay attention to where I call NotifyComplete()! This method releases all the resources used by the agent. It is important to call this method because otherwise the task will never end and thus will never start again. It is also very important to call it when everything is done – in this particular case in the DownloadStringCompleted event, after updating the live tiles.

This leaves us with only one thing left to do: registering the scheduled task. We will do this in the Application\_Launching event (found in App.xaml.cs).

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
