---
title: "Atualize periodicamente suas live tiles usando ScheduledTaskAgent"
description: "Use um ScheduledTaskAgent para atualizar periodicamente as live tiles do seu Windows Phone a partir de um feed RSS."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "pt-br"
translationOf: "2013/06/periodically-update-your-live-tiles-using-scheduledtaskagent"
translatedBy: "claude"
translationDate: 2026-05-01
---
Em um post anterior, mostrei [como criar wide tiles para sua aplicação Windows Phone 7](/pt-br/2013/05/creating-wide-tiles-for-your-windows-phone-7-app/). Agora é hora de dar vida a elas. A forma mais fácil é usar um ScheduledTaskAgent. Para criar um, adicione um novo projeto à solução e, na lista de templates, escolha 'Windows Phone Scheduled Task Agent'.

Antes de prosseguir, adicione esse novo projeto (task agent) como referência no projeto principal da aplicação.

Isso vai criar uma classe chamada 'ScheduledAgent' que herda de 'ScheduledTaskAgent'. Você pode deixar o construtor da classe e o handler de exceção como estão. O método que nos interessa é o 'OnInvoke'. Esse é o método chamado periodicamente enquanto o agent estiver rodando.

Aqui é onde atualizamos a live tile. Suponhamos que atualizamos a partir de um feed RSS. A primeira coisa é baixar o feed.

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

Depois de baixado, desserialize, pegue o primeiro (mais recente) item e use o título e a imagem para atualizar a live tile.

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

Repare onde chamo o NotifyComplete(). Esse método libera todos os recursos usados pelo agent. É importante chamá-lo, porque caso contrário a task nunca termina e, portanto, nunca inicia de novo. Também é muito importante chamá-lo quando tudo estiver pronto -- nesse caso, no evento DownloadStringCompleted, após atualizar as live tiles.

Só falta uma coisa: registrar a tarefa programada. Vamos fazer isso no evento Application\_Launching (em App.xaml.cs).

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
