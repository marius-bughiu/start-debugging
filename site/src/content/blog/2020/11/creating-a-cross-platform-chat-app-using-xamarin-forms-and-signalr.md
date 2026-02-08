---
title: "Creating a cross-platform chat app using Xamarin Forms and SignalR"
description: "Build a cross-platform real-time chat app in under 5 minutes using Xamarin Forms for the client and ASP.NET Core SignalR for the backend."
pubDate: 2020-11-09
updatedDate: 2023-11-05
tags:
  - "signalr"
  - "xamarin"
  - "xamarin-forms"
---
In less than 5 minutes.

First step is to create your Xamarin Forms projects – start with a blank shell app – and add an additional blank ASP.NET Core project to the solution – we will use it to host our SignalR backend.

Once the projects are set up, we begin by implementing the `ChatHub` which in our case is really basic.

```cs
public class ChatHub : Hub
{
    public async Task Send(string from, string message)
    {
        await Clients.Others.SendAsync("broadcastMessage", from, message);
    }
}
```

This is our SignalR chat hub to which our Xamarin client apps will connect. It only has one method – `Send` – which accepts two parameters: the name of the user sending the message (from) and the actual message. This will then call the “broadcastMessage” method on all the connected clients except the sender (we don’t want the message we send to be sent back to us).  
  
All that’s left to do is to register SignalR and the ChatHub and we’re done with the backend part. To do so, open up `Startup.cs` and inside the `ConfigureServices` method add the following line:

```cs
services.AddSignalR();
```

And inside the `Configure` method add an endpoint mapping for your hub. You already have a default mapping in there, so just add it next to it. This is how it should look:

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

Build and run the web project. If everything is OK, you will see "Hello World!" in your browser window.

## The Xamarin client

On the client side we want something simple:

-   a Connect button
-   a list with chat messages
-   a textbox where you can type your own message
-   a Send button

Note: you might argue that we don’t need a Connect button, and that’s true in most cases, but when you debug all projects at once, you can’t automatically connect to the hub, because most of the time the web app hasn’t finished warming up by the time the app initializes and you will end up with a connection error.

The main flow that we want to achieve:

-   when launching the application we only want the Connect button and the list of messages to be visible
-   after connecting to the hub, we want the Connect button to disappear and to display the message `Entry` and the Send button
-   pressing Connect will connect to the chat hub
-   upon receiving a message we will display it on the UI
-   sending a message will send it to the hub and also add it to the messages list on the UI
-   in case of any error we display it as a message

Feel free to create the UI as you like, here’s my version of it:

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

If something doesn’t work, you can check out a working sample here: [Xamarin Forms – SignalR Chat](https://github.com/marius-bughiu/xamarin-forms-signalr-chat), or you can reach out in the comments below.
