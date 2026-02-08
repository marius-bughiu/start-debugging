---
title: "How to use appsettings.json with Xamarin.Forms"
description: "There are two key differences compared to ASP.NET: To get started, add an appsettings.json file in your shared project. Make sure you set it’s Build Action to Embeded Resource. Add some keys + value in the file that we can use for testing. For example: Next, we need to get hold of the resource stream…."
pubDate: 2020-11-13
updatedDate: 2023-11-05
tags:
  - "c-sharp"
  - "xamarin-forms"
---
There are two key differences compared to ASP.NET:

-   first, we’ll be working with an Embeded Resource as opposed to a file on the disk
-   second – we will register the `appsettings.json` file ourselves

To get started, add an `appsettings.json` file in your shared project. Make sure you set it’s `Build Action` to `Embeded Resource`. Add some keys + value in the file that we can use for testing. For example:

```json
{
  "ChatHubUrl": "https://signalrchatweb.azurewebsites.net/"
}
```

Next, we need to get hold of the resource stream.

```cs
Stream resourceStream = GetType().GetTypeInfo().Assembly.GetManifestResourceStream("SignalRChat.appsettings.json");
```

And use it to build an `IConfiguration` object.

```cs
var configuration = new ConfigurationBuilder()
                .AddJsonStream(resourceStream)
                .Build();
```

Now, in order to pull the configuration values from it, just use it like you would any other dictionary.

```cs
configuration["ChatHubUrl"];
```

Alternatively you can register it into your IoC container as an `IConfiguration` , inject that into your viewmodels and use it in the same way.

For a complete example you can check out this repository on GitHub: [Xamarin Forms – SignalR Chat](https://github.com/marius-bughiu/xamarin-forms-signalr-chat).
