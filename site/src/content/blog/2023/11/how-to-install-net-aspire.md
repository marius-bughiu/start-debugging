---
title: "How to install .NET Aspire"
description: "Learn how to install the prerequisites for .NET Aspire development: .NET 8, the Aspire workload, and Docker Desktop."
pubDate: 2023-11-15
tags:
  - "aspire"
  - "net"
---
.NET Aspire is a comprehensive, cloud-oriented framework designed for creating scalable, observable, and production-grade distributed applications. In this article we’ll look at the prerequisites of getting started with .NET Aspire. If you want an overview of .NET Aspire and what it brings to the table, check out our [What is .NET Aspire](/2023/11/what-is-net-aspire/) article.

There are three main things you will need in order to develop applications using .NET Aspire:

-   [.NET 8](#install-net-8)
-   the [.NET Aspire workload](#install-the-net-aspire-workload)
-   and [Docker Desktop](#install-docker-desktop)

If you are planning to use Visual Studio for developing your application, note that you will need to use Visual Studio 2022 Preview, version 17.9 or higher.

## Install .NET 8

If you’re using Visual Studio and you’ve already updated to the latest version, then you already have .NET 8 installed. If you are not on the latest version, make sure you are using Visual Studio version 17.9 or higher and that should have you covered.

If you are not using Visual Studio, you can download and install the .NET 8 SDK from here: [https://dotnet.microsoft.com/en-us/download/dotnet/8.0](https://dotnet.microsoft.com/en-us/download/dotnet/8.0)

## Install the .NET Aspire workload

The .NET Aspire workload can be installed one of two ways:

-   from command-line using the dotnet CLI
-   or using the Visual Studio Installer (for Visual Studio note that you will need VS 17.9 or higher)

### Using .NET CLI

The command to install .NET Aspire from command line is quite simple. Just make sure you have the .NET 8 SDK installed and you are ready to run the install workload command:

```bash
dotnet workload install aspire
```

### Using the Visual Studio Installer

In your Visual Studio Installer, make sure you select the **ASP.NET and web development** workload, and then on the right panel, under **Optional**, make sure to check **.NET Aspire SDK (Preview)**, then click **Modify** to begin the install process.

[![](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

## Install Docker Desktop

You can download the latest version of Docker for Desktop here: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)

Run through the installer with the default options and, after a restart, you should be good to go.

[![](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Note that Docker Desktop is free only for personal use by individual developers, education and open source community. Any other kind of usage is subject to a license fee. Make sure to check [their pricing page](https://www.docker.com/pricing/) if you are in doubt.

With everything installed, you are now ready to start building with .NET Aspire!
