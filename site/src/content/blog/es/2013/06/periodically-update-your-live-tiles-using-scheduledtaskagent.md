---
title: "Actualizar periódicamente tus live tiles con ScheduledTaskAgent"
description: "Usa un ScheduledTaskAgent para actualizar periódicamente las live tiles de tu Windows Phone desde un feed RSS."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "es"
translationOf: "2013/06/periodically-update-your-live-tiles-using-scheduledtaskagent"
translatedBy: "claude"
translationDate: 2026-05-01
---
En un post anterior cubrí [cómo crear wide tiles para tu aplicación de Windows Phone 7](/es/2013/05/creating-wide-tiles-for-your-windows-phone-7-app/). Ahora es momento de darles vida. La forma más sencilla es usar un ScheduledTaskAgent. Para crear uno, añade un nuevo proyecto a tu solución y, en la lista de plantillas, elige 'Windows Phone Scheduled Task Agent'.

Antes de seguir, añade este nuevo proyecto (task agent) como referencia en el proyecto principal de la aplicación.

Esto creará una clase llamada 'ScheduledAgent' que hereda de 'ScheduledTaskAgent'. Puedes dejar el constructor de la clase y el manejador de excepciones tal como están. El método que nos interesa es 'OnInvoke'. Este es el método que se llamará periódicamente mientras el agent esté ejecutándose.

Aquí es donde actualizaremos nuestra live tile. Supongamos que la actualizamos a partir de un feed RSS. Lo primero que necesitamos es descargar el feed.

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

Una vez descargado, deserialízalo, toma el primer (más reciente) elemento y usa el título y la imagen para actualizar tu live tile.

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

Fíjate en dónde llamo a NotifyComplete(). Este método libera todos los recursos usados por el agent. Es importante llamarlo, porque si no la tarea no terminará y, por tanto, nunca volverá a iniciarse. También es muy importante llamarlo cuando todo esté hecho; en este caso particular, en el evento DownloadStringCompleted, después de actualizar las live tiles.

Solo nos queda una cosa por hacer: registrar la tarea programada. Lo haremos en el evento Application\_Launching (en App.xaml.cs).

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
