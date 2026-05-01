---
title: "Как установить .NET Aspire (dotnet workload install aspire)"
description: "Установите .NET Aspire через `dotnet workload install aspire`. Пошаговая настройка .NET 8, workload Aspire и Docker на Windows, macOS и Linux."
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "ru"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET Aspire — это комплексный, ориентированный на облако фреймворк, предназначенный для создания масштабируемых, наблюдаемых распределённых приложений промышленного уровня. В этой статье мы рассмотрим предварительные требования для начала работы с .NET Aspire. Если вам нужен обзор .NET Aspire и того, что он предлагает, ознакомьтесь со статьёй [What is .NET Aspire](/ru/2023/11/what-is-net-aspire/).

Есть три основные вещи, которые понадобятся для разработки приложений с использованием .NET Aspire:

-   [.NET 8](#install-net-8)
-   [workload .NET Aspire](#install-the-net-aspire-workload)
-   и [Docker Desktop](#install-docker-desktop)

Если вы планируете использовать Visual Studio для разработки приложения, обратите внимание, что вам понадобится Visual Studio 2022 Preview версии 17.9 или выше.

## Install .NET 8

Если вы используете Visual Studio и уже обновились до последней версии, то .NET 8 у вас уже установлен. Если вы не на последней версии, убедитесь, что используете Visual Studio версии 17.9 или выше, и этого должно быть достаточно.

Если вы не пользуетесь Visual Studio, можете загрузить и установить .NET 8 SDK отсюда: [https://dotnet.microsoft.com/en-us/download/dotnet/8.0](https://dotnet.microsoft.com/en-us/download/dotnet/8.0)

## Install the .NET Aspire workload

Workload .NET Aspire можно установить двумя способами:

-   из командной строки с помощью CLI dotnet
-   или через Visual Studio Installer (для Visual Studio обратите внимание, что вам понадобится VS 17.9 или выше)

### Using .NET CLI

Команда для установки .NET Aspire из командной строки довольно проста. Просто убедитесь, что .NET 8 SDK установлен, и можете запускать команду установки workload:

```bash
dotnet workload install aspire
```

### Using the Visual Studio Installer

В Visual Studio Installer выберите workload **ASP.NET and web development**, затем в правой панели в разделе **Optional** отметьте **.NET Aspire SDK (Preview)** и нажмите **Modify**, чтобы запустить процесс установки.

[![](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

## Install Docker Desktop

Последнюю версию Docker Desktop можно загрузить здесь: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)

Пройдите установщик с параметрами по умолчанию, и после перезагрузки всё должно быть готово.

[![](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Учтите, что Docker Desktop бесплатен только для личного использования отдельными разработчиками, для образования и сообщества с открытым исходным кодом. Любое другое использование подлежит лицензионной плате. При сомнениях ознакомьтесь со [страницей цен](https://www.docker.com/pricing/).

Когда всё установлено, вы готовы начинать создавать приложения на .NET Aspire!
