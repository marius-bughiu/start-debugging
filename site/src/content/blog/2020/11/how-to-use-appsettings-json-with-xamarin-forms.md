---
title: "How to use appsettings.json with Xamarin.Forms"
description: "Learn how to use appsettings.json configuration files with Xamarin.Forms by embedding the file as a resource and building an IConfiguration object."
pubDate: 2020-11-13
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin-forms"
---
There are two key differences compared to ASP.NET:

-   first, we'll be working with an Embedded Resource as opposed to a file on the disk
-   second – we will register the `appsettings.json` file ourselves

To get started, add an `appsettings.json` file in your shared project. Make sure you set its `Build Action` to `Embedded Resource`. Add some keys + value in the file that we can use for testing. For example:

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

A complete example originally lived in the Xamarin Forms – SignalR Chat repository on GitHub, which is no longer available.
