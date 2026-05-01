---
title: "Создание кроссплатформенного чата с использованием Xamarin Forms и SignalR"
description: "Постройте кроссплатформенное приложение чата в реальном времени менее чем за 5 минут, используя Xamarin Forms для клиента и ASP.NET Core SignalR для бэкенда."
pubDate: 2020-11-09
updatedDate: 2023-11-05
tags:
  - "signalr"
  - "xamarin"
  - "xamarin-forms"
lang: "ru"
translationOf: "2020/11/creating-a-cross-platform-chat-app-using-xamarin-forms-and-signalr"
translatedBy: "claude"
translationDate: 2026-05-01
---
Менее чем за 5 минут.

Первый шаг - создать проекты Xamarin Forms (начните с blank shell app) и добавить в решение дополнительный пустой проект ASP.NET Core; мы будем использовать его для размещения нашего бэкенда SignalR.

Когда проекты настроены, начнём с реализации `ChatHub`, который в нашем случае очень простой.

```cs
public class ChatHub : Hub
{
    public async Task Send(string from, string message)
    {
        await Clients.Others.SendAsync("broadcastMessage", from, message);
    }
}
```

Это наш SignalR-чат-хаб, к которому будут подключаться клиентские приложения Xamarin. У него только один метод - `Send` - принимающий два параметра: имя пользователя, отправляющего сообщение (from), и само сообщение. Затем он вызовет метод "broadcastMessage" на всех подключённых клиентах, кроме отправителя (мы не хотим, чтобы отправленное нами сообщение возвращалось обратно).

Осталось только зарегистрировать SignalR и ChatHub - и с бэкендом всё. Для этого откройте `Startup.cs` и в методе `ConfigureServices` добавьте следующую строку:

```cs
services.AddSignalR();
```

А внутри метода `Configure` добавьте маппинг конечной точки для вашего хаба. Там уже есть маппинг по умолчанию, поэтому просто добавьте новый рядом с ним. Должно получиться так:

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

Соберите и запустите веб-проект. Если всё в порядке, в окне браузера вы увидите "Hello World!".

## Клиент Xamarin

На стороне клиента нам нужно нечто простое:

-   кнопка Connect
-   список сообщений чата
-   текстовое поле, в котором можно набрать собственное сообщение
-   кнопка Send

Замечание: можно возразить, что кнопка Connect не нужна, и в большинстве случаев это верно, но при отладке всех проектов одновременно автоматически подключиться к хабу не получится: чаще всего веб-приложение ещё не успело прогреться к моменту инициализации приложения, и вы получите ошибку соединения.

Главный целевой сценарий:

-   при запуске приложения видимы только кнопка Connect и список сообщений
-   после подключения к хабу кнопка Connect должна исчезнуть, а вместо неё отобразиться `Entry` для сообщения и кнопка Send
-   нажатие Connect выполнит подключение к чат-хабу
-   при получении сообщения отобразим его в UI
-   отправка сообщения отправит его в хаб и добавит в список сообщений в UI
-   при любой ошибке покажем её как сообщение

Создавайте UI как пожелаете; вот моя версия:

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

Если что-то не работает, исходный демонстрационный репозиторий Xamarin Forms -- SignalR Chat больше не доступен на GitHub, но вы можете написать в комментариях ниже.
