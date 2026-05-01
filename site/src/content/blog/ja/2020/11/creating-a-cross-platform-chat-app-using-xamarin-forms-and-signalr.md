---
title: "Xamarin Forms と SignalR でクロスプラットフォームのチャットアプリを作る"
description: "クライアントに Xamarin Forms、バックエンドに ASP.NET Core SignalR を使って、5 分以内にクロスプラットフォームのリアルタイムチャットアプリを構築します。"
pubDate: 2020-11-09
updatedDate: 2023-11-05
tags:
  - "signalr"
  - "xamarin"
  - "xamarin-forms"
lang: "ja"
translationOf: "2020/11/creating-a-cross-platform-chat-app-using-xamarin-forms-and-signalr"
translatedBy: "claude"
translationDate: 2026-05-01
---
5 分もかかりません。

最初のステップは Xamarin Forms プロジェクトを作成すること (空の shell app から始めます) と、ソリューションに追加で空の ASP.NET Core プロジェクトを加えることです。これを SignalR バックエンドのホストに使います。

プロジェクトの準備ができたら、まずは `ChatHub` を実装します。今回のものは非常にシンプルです。

```cs
public class ChatHub : Hub
{
    public async Task Send(string from, string message)
    {
        await Clients.Others.SendAsync("broadcastMessage", from, message);
    }
}
```

これは Xamarin クライアントアプリが接続する SignalR の chat hub です。メソッドは 1 つだけ -- `Send` -- で、メッセージを送信するユーザー名 (from) と実際のメッセージという 2 つのパラメーターを受け取ります。これにより、送信者を除く接続中のすべてのクライアントで "broadcastMessage" メソッドが呼び出されます (送信したメッセージが自分に戻ってくるのは望ましくありません)。

あとは SignalR と ChatHub を登録するだけで、バックエンドは完了です。`Startup.cs` を開き、`ConfigureServices` メソッド内に次の行を追加します。

```cs
services.AddSignalR();
```

そして `Configure` メソッド内に hub のエンドポイントマッピングを追加します。すでに既定のマッピングがあるはずなので、その隣に追加してください。次のような形になります。

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

Web プロジェクトをビルドして実行してください。問題がなければ、ブラウザーのウィンドウに "Hello World!" と表示されます。

## Xamarin クライアント

クライアント側ではシンプルなものを目指します。

-   Connect ボタン
-   チャットメッセージの一覧
-   自分のメッセージを入力できるテキストボックス
-   Send ボタン

メモ: Connect ボタンは不要では、と思うかもしれません。多くの場合それは正しいのですが、すべてのプロジェクトを同時にデバッグする場合、自動で hub に接続するのは難しいです。たいていアプリの初期化時点ではまだ Web アプリのウォームアップが終わっておらず、接続エラーになります。

実現したい主なフローは次のとおりです。

-   アプリ起動時には Connect ボタンとメッセージ一覧だけを表示する
-   hub に接続したら Connect ボタンを非表示にし、メッセージの `Entry` と Send ボタンを表示する
-   Connect を押すと chat hub に接続する
-   メッセージを受信したら UI に表示する
-   メッセージを送信すると hub に送信し、UI 上のメッセージ一覧にも追加する
-   何らかのエラーが発生した場合はメッセージとして表示する

UI は自由に作って構いません。以下は私のバージョンです。

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

うまくいかない場合は、元の Xamarin Forms -- SignalR Chat サンプルリポジトリは GitHub では公開されなくなりましたが、下のコメントでお気軽にご連絡ください。
