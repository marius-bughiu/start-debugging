---
title: "Xamarin.Forms で appsettings.json を使う方法"
description: "Xamarin.Forms で appsettings.json 構成ファイルを使う方法を、ファイルをリソースとして埋め込み、IConfiguration オブジェクトを構築する形で解説します。"
pubDate: 2020-11-13
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin-forms"
lang: "ja"
translationOf: "2020/11/how-to-use-appsettings-json-with-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
ASP.NET と比較して、重要な違いが 2 つあります。

-   1 つ目は、ディスク上のファイルではなく Embedded Resource を扱うこと
-   2 つ目は、`appsettings.json` ファイルを自分で登録すること

まず、共有プロジェクトに `appsettings.json` ファイルを追加します。`Build Action` を必ず `Embedded Resource` に設定してください。テストに使えるキーと値をいくつか追加します。例えば次のようになります。

```json
{
  "ChatHubUrl": "https://signalrchatweb.azurewebsites.net/"
}
```

次に、リソースのストリームを取得します。

```cs
Stream resourceStream = GetType().GetTypeInfo().Assembly.GetManifestResourceStream("SignalRChat.appsettings.json");
```

そして、それを使って `IConfiguration` オブジェクトを構築します。

```cs
var configuration = new ConfigurationBuilder()
                .AddJsonStream(resourceStream)
                .Build();
```

あとは、構成値を取得するために、他の辞書と同じように使うだけです。

```cs
configuration["ChatHubUrl"];
```

あるいは、IoC コンテナーに `IConfiguration` として登録し、ViewModel に注入して同じように使うこともできます。

完全な例はかつて GitHub の Xamarin Forms -- SignalR Chat リポジトリにありましたが、現在は公開されていません。
