---
title: "Plattformübergreifende Chat-App mit Xamarin Forms und SignalR erstellen"
description: "Erstellen Sie in unter 5 Minuten eine plattformübergreifende Echtzeit-Chat-App mit Xamarin Forms als Client und ASP.NET Core SignalR als Backend."
pubDate: 2020-11-09
updatedDate: 2023-11-05
tags:
  - "signalr"
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2020/11/creating-a-cross-platform-chat-app-using-xamarin-forms-and-signalr"
translatedBy: "claude"
translationDate: 2026-05-01
---
In weniger als 5 Minuten.

Der erste Schritt besteht darin, Ihre Xamarin-Forms-Projekte zu erstellen (beginnen Sie mit einer leeren Shell App) und der Solution zusätzlich ein leeres ASP.NET-Core-Projekt hinzuzufügen, in dem wir unser SignalR-Backend hosten.

Sind die Projekte eingerichtet, beginnen wir mit der Implementierung des `ChatHub`, der in unserem Fall sehr einfach gehalten ist.

```cs
public class ChatHub : Hub
{
    public async Task Send(string from, string message)
    {
        await Clients.Others.SendAsync("broadcastMessage", from, message);
    }
}
```

Das ist unser SignalR-Chat-Hub, mit dem sich unsere Xamarin-Client-Apps verbinden. Er hat nur eine Methode -- `Send` -- die zwei Parameter akzeptiert: den Namen des Benutzers, der die Nachricht sendet (from), und die eigentliche Nachricht. Diese ruft anschließend die Methode "broadcastMessage" auf allen verbundenen Clients außer dem Absender auf (wir wollen die gesendete Nachricht nicht an uns selbst zurückerhalten).

Übrig bleibt nur, SignalR und den ChatHub zu registrieren, dann ist der Backend-Teil erledigt. Öffnen Sie dazu `Startup.cs` und fügen Sie in der Methode `ConfigureServices` folgende Zeile ein:

```cs
services.AddSignalR();
```

Und fügen Sie in der Methode `Configure` ein Endpoint-Mapping für Ihren Hub hinzu. Es existiert dort bereits ein Standard-Mapping, fügen Sie das neue einfach daneben ein. So sollte es aussehen:

```cs
app.UseEndpoints(endpoints =>
        {
            endpoints.MapGet("/", async context =>
            {
                await context.Response.WriteAsync("Hello World!");
            });

            endpoints.MapHub<ChatHub>("/chat");
        });
```

Bauen Sie das Web-Projekt und führen Sie es aus. Wenn alles in Ordnung ist, sehen Sie "Hello World!" in Ihrem Browserfenster.

## Der Xamarin-Client

Auf Client-Seite wollen wir etwas Einfaches:

-   einen Connect-Button
-   eine Liste mit Chat-Nachrichten
-   eine Textbox, in der Sie Ihre eigene Nachricht eingeben können
-   einen Send-Button

Hinweis: Sie könnten argumentieren, dass wir keinen Connect-Button brauchen, und in den meisten Fällen stimmt das. Wenn Sie aber alle Projekte gleichzeitig debuggen, können Sie sich nicht automatisch mit dem Hub verbinden, weil die Web-App in den meisten Fällen noch nicht warmgelaufen ist, wenn die App initialisiert wird, und Sie landen bei einem Verbindungsfehler.

Der gewünschte Hauptablauf:

-   Beim Start der Anwendung sollen nur der Connect-Button und die Liste der Nachrichten sichtbar sein
-   Nach der Verbindung mit dem Hub soll der Connect-Button verschwinden und stattdessen das Nachrichten-`Entry` und der Send-Button erscheinen
-   Connect zu drücken stellt die Verbindung mit dem Chat-Hub her
-   Beim Empfang einer Nachricht zeigen wir sie in der UI an
-   Eine Nachricht zu senden schickt sie an den Hub und fügt sie außerdem zur Nachrichtenliste in der UI hinzu
-   Bei einem Fehler zeigen wir ihn als Nachricht an

Gestalten Sie die UI nach Belieben; hier ist meine Version:

```xml
<ContentPage xmlns="http://xamarin.com/schemas/2014/forms"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="SignalRChat.MainPage">

    <Grid>
        <Grid.RowDefinitions>
            <RowDefinition Height="*" />
            <RowDefinition Height="Auto" />
        </Grid.RowDefinitions>
        <ListView ItemsSource="{Binding Messages}">
            <ListView.ItemTemplate>
                <DataTemplate>
                    <ViewCell>
                        <Grid>
                            <Grid.ColumnDefinitions>
                                <ColumnDefinition Width="Auto" />
                                <ColumnDefinition Width="*" />
                            </Grid.ColumnDefinitions>
                            <Label Text="{Binding From}" FontAttributes="Bold" />
                            <Label Grid.Column="1" Text="{Binding Content}" />
                        </Grid>
                    </ViewCell>
                </DataTemplate>
            </ListView.ItemTemplate>
        </ListView>
        <Button Command="{Binding ConnectCommand}" IsVisible="{Binding IsConnected, Converter={StaticResource BooleanToOppositeBooleanConverter}}" Grid.Row="1" Text="Connect" />
        <Grid IsVisible="{Binding IsConnected}" Grid.Row="1">
            <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*" />
                <ColumnDefinition Width="Auto" />
            </Grid.ColumnDefinitions>
            <Entry Text="{Binding Message, Mode=TwoWay}" />
            <Button Command="{Binding SendCommand}" Grid.Column="1" Text="SEND" TextColor="White" Background="#0069c0" />
        </Grid>
    </Grid>

</ContentPage>
```

Falls etwas nicht funktioniert: Das ursprüngliche Beispielrepository Xamarin Forms -- SignalR Chat ist auf GitHub nicht mehr verfügbar, aber Sie können sich gerne in den Kommentaren unten melden.
