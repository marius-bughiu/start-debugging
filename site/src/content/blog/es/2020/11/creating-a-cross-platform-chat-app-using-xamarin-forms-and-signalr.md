---
title: "Crear una app de chat multiplataforma con Xamarin Forms y SignalR"
description: "Construye una app de chat en tiempo real multiplataforma en menos de 5 minutos usando Xamarin Forms para el cliente y ASP.NET Core SignalR para el backend."
pubDate: 2020-11-09
updatedDate: 2023-11-05
tags:
  - "signalr"
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2020/11/creating-a-cross-platform-chat-app-using-xamarin-forms-and-signalr"
translatedBy: "claude"
translationDate: 2026-05-01
---
En menos de 5 minutos.

El primer paso es crear tus proyectos de Xamarin Forms (empieza con una blank shell app) y añadir un proyecto ASP.NET Core en blanco adicional a la solución; lo usaremos para hospedar nuestro backend SignalR.

Una vez configurados los proyectos, comenzamos implementando el `ChatHub`, que en nuestro caso es realmente básico.

```cs
public class ChatHub : Hub
{
    public async Task Send(string from, string message)
    {
        await Clients.Others.SendAsync("broadcastMessage", from, message);
    }
}
```

Este es nuestro chat hub de SignalR al que se conectarán nuestras apps cliente Xamarin. Solo tiene un método -- `Send` -- que acepta dos parámetros: el nombre del usuario que envía el mensaje (from) y el mensaje en sí. Esto llamará al método "broadcastMessage" en todos los clientes conectados excepto el remitente (no queremos que el mensaje que enviamos nos vuelva).

Lo único que queda es registrar SignalR y el ChatHub, y habremos terminado con la parte del backend. Para hacerlo, abre `Startup.cs` y dentro del método `ConfigureServices` añade la siguiente línea:

```cs
services.AddSignalR();
```

Y dentro del método `Configure` añade un mapeo de endpoint para tu hub. Ya tienes un mapeo predeterminado allí, así que añade el nuevo junto a él. Debería verse así:

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

Compila y ejecuta el proyecto web. Si todo está bien, verás "Hello World!" en la ventana de tu navegador.

## El cliente Xamarin

En el lado del cliente queremos algo simple:

-   un botón Connect
-   una lista con los mensajes del chat
-   un cuadro de texto donde puedas escribir tu propio mensaje
-   un botón Send

Nota: podrías argumentar que no necesitamos un botón Connect, y eso es cierto en la mayoría de los casos, pero cuando depuras todos los proyectos a la vez no puedes conectarte automáticamente al hub porque la mayor parte del tiempo la web app no ha terminado de calentarse cuando la app se inicializa, y acabarás con un error de conexión.

El flujo principal que queremos lograr:

-   al iniciar la aplicación solo queremos que el botón Connect y la lista de mensajes sean visibles
-   tras conectarse al hub, queremos que el botón Connect desaparezca y se muestren la `Entry` del mensaje y el botón Send
-   pulsar Connect se conectará al chat hub
-   al recibir un mensaje, lo mostraremos en la UI
-   enviar un mensaje lo enviará al hub y también lo añadirá a la lista de mensajes en la UI
-   ante cualquier error, lo mostraremos como un mensaje

Crea la UI a tu gusto; aquí está mi versión:

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

Si algo no funciona, el repositorio de ejemplo original Xamarin Forms -- SignalR Chat ya no está disponible en GitHub, pero puedes contactar en los comentarios más abajo.
