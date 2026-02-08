---
title: "The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found."
description: "Fix the 'Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found' error by updating your Azure App Service stack and .NET runtime version."
pubDate: 2020-12-20
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "azure"
  - "docker"
---
This error usually means that there is a mismatch between the AppService Stack and .NET version and your app’s target framework. This can happen when you upgrade your web app, but you do not update the runtime of the App Service.  
  
This is a common occurrence for ASP.NET MVC and Web API projects going through a .NET major version upgrade, and it’s quite simple to fix.

If you get this error, go to your App Service > Settings > Configuration and make sure that the Stack and the framework version match your app. In our case, after upgrading from .NET Core 3.1 to .NET 5 we had to switch the Stack from .NET Core to .NET and choose version 5.  
  
After making the changes, you will also need to manually restart the App Service for them to take effect.

![](/wp-content/uploads/2020/12/image-1024x463.png)

The complete error message:

> HTTP Error 500.31 – ANCM Failed to Find Native Dependencies Common solutions to this issue: The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found. Specific error detected by ANCM: Error: An assembly specified in the application dependencies manifest (Microsoft.AspNetCore.AzureAppServices.HostingStartup.deps.json) was not found: package: ‘Microsoft.Extensions.Logging.AzureAppServices’, version: ‘6.0.1’ path: ‘lib/net6.0/Microsoft.Extensions.Logging.AzureAppServices.dll

## Docker – The framework ‘Microsoft.AspNetCore.App’, version ‘6.0.0’ (x64) was not found

```plaintext
It was not possible to find any compatible framework version
The framework 'Microsoft.AspNetCore.App', version '6.0.0' (x64) was not found.
  - No frameworks were found.
You can resolve the problem by installing the specified framework and/or SDK.
The specified framework can be found at:
  - https://aka.ms/dotnet-core-applaunch?framework=Microsoft.AspNetCore.App&framework_version=6.0.0&arch=x64&rid=debian.11-x64
```

This basically says that you are using a docker image which doesn’t have the .NET runtime required by your application. What you will need is the 6.0 docker image for ASP.NET.

```plaintext
docker pull mcr.microsoft.com/dotnet/aspnet:6.0
```

## Upgrade your dependencies to match the .NET version

You might find yourself in the situation where the target framework of your web application and that of the app service are actually a match, but you still get the same error.

If that is the case, it might be that you are still referencing some older packages which go looking for an older version of ASP.NET – such as the `ASP.NET Core Logging Integration`. Make sure you update the extension to a version which matches your target framework and your problem should be fixed.

The same goes for third-party dependencies, such as `MiniProfiler.AspNetCore` – make sure you are using a version which is compatible with your target ASP.NET runtime, otherwise it can lead to errors such as the one we cover.
