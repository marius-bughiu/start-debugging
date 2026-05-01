---
title: "Периодическое обновление live tiles с помощью ScheduledTaskAgent"
description: "Используйте ScheduledTaskAgent, чтобы периодически обновлять live tiles вашего Windows Phone из RSS-фида."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "ru"
translationOf: "2013/06/periodically-update-your-live-tiles-using-scheduledtaskagent"
translatedBy: "claude"
translationDate: 2026-05-01
---
В предыдущем посте я рассказывал, [как создать wide tiles для приложения Windows Phone 7](/ru/2013/05/creating-wide-tiles-for-your-windows-phone-7-app/). Теперь пора оживить их. Самый простой способ - использовать ScheduledTaskAgent. Чтобы создать его, добавьте в решение новый проект и в списке шаблонов выберите 'Windows Phone Scheduled Task Agent'.

Прежде чем двигаться дальше, добавьте этот новый проект (task agent) как ссылку в основном проекте приложения.

Создастся класс 'ScheduledAgent', наследующий 'ScheduledTaskAgent'. Конструктор класса и обработчик исключений можно оставить как есть. Нас интересует метод 'OnInvoke'. Именно он будет вызываться периодически, пока agent работает.

Здесь мы будем обновлять live tile. Допустим, обновляем её из RSS-фида. Первое, что нужно сделать, - скачать фид.

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

Скачав, десериализуйте, возьмите первый (самый свежий) элемент и используйте заголовок и изображение для обновления live tile.

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

Обратите внимание, где я вызываю NotifyComplete(). Этот метод освобождает все ресурсы, занятые agent'ом. Его важно вызвать, иначе задача никогда не завершится и, следовательно, никогда не запустится снова. Также очень важно вызвать его, когда всё уже сделано, - в данном случае в обработчике DownloadStringCompleted, после обновления live tiles.

Осталось одно: зарегистрировать запланированную задачу. Сделаем это в событии Application\_Launching (в App.xaml.cs).

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
