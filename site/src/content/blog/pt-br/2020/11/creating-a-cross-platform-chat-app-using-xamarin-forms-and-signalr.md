---
title: "Criando um app de chat multiplataforma com Xamarin Forms e SignalR"
description: "Construa um app de chat em tempo real multiplataforma em menos de 5 minutos usando Xamarin Forms para o cliente e ASP.NET Core SignalR para o backend."
pubDate: 2020-11-09
updatedDate: 2023-11-05
tags:
  - "signalr"
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2020/11/creating-a-cross-platform-chat-app-using-xamarin-forms-and-signalr"
translatedBy: "claude"
translationDate: 2026-05-01
---
Em menos de 5 minutos.

O primeiro passo é criar seus projetos Xamarin Forms (comece com um blank shell app) e adicionar um projeto ASP.NET Core em branco à solução; vamos usá-lo para hospedar nosso backend SignalR.

Com os projetos configurados, começamos implementando o `ChatHub`, que no nosso caso é bem básico.

```cs
public class ChatHub : Hub
{
    public async Task Send(string from, string message)
    {
        await Clients.Others.SendAsync("broadcastMessage", from, message);
    }
}
```

Esse é o nosso chat hub do SignalR ao qual nossos apps cliente Xamarin se conectarão. Ele só tem um método -- `Send` -- que aceita dois parâmetros: o nome do usuário que envia a mensagem (from) e a mensagem em si. Isso, então, chamará o método "broadcastMessage" em todos os clientes conectados, exceto no remetente (não queremos que a mensagem que enviamos volte para nós).

Resta apenas registrar o SignalR e o ChatHub e estaremos prontos com a parte do backend. Para isso, abra `Startup.cs` e dentro do método `ConfigureServices` adicione a seguinte linha:

```cs
services.AddSignalR();
```

E dentro do método `Configure` adicione um mapeamento de endpoint para o seu hub. Você já tem um mapeamento padrão lá, então só adicione ao lado dele. Deve ficar assim:

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

Compile e execute o projeto web. Se tudo estiver OK, você verá "Hello World!" na janela do navegador.

## O cliente Xamarin

No lado do cliente queremos algo simples:

-   um botão Connect
-   uma lista com mensagens do chat
-   um campo de texto onde você possa digitar sua própria mensagem
-   um botão Send

Observação: você pode argumentar que não precisamos de um botão Connect, e isso é verdade na maioria dos casos, mas quando você depura todos os projetos ao mesmo tempo, não é possível conectar automaticamente ao hub porque, na maioria das vezes, o web app ainda não terminou de aquecer quando o app inicializa, e você acaba com um erro de conexão.

Fluxo principal que queremos alcançar:

-   ao iniciar a aplicação, queremos apenas o botão Connect e a lista de mensagens visíveis
-   após conectar ao hub, queremos que o botão Connect desapareça e que sejam exibidos a `Entry` da mensagem e o botão Send
-   pressionar Connect conectará ao chat hub
-   ao receber uma mensagem, vamos exibi-la na UI
-   enviar uma mensagem a enviará para o hub e também a adicionará à lista de mensagens na UI
-   em caso de erro, vamos exibi-lo como uma mensagem

Sinta-se à vontade para criar a UI como quiser; aqui vai a minha versão:

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

Se algo não funcionar, o repositório de exemplo original Xamarin Forms -- SignalR Chat não está mais disponível no GitHub, mas você pode entrar em contato pelos comentários abaixo.
