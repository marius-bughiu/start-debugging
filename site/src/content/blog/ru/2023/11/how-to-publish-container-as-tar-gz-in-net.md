---
title: "Как опубликовать контейнер как tar.gz в .NET"
description: "Узнайте, как опубликовать контейнер .NET 8 в виде архива tar.gz с помощью свойства ContainerArchiveOutputPath и dotnet publish."
pubDate: 2023-11-11
tags:
  - "docker"
  - "dotnet"
lang: "ru"
translationOf: "2023/11/how-to-publish-container-as-tar-gz-in-net"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8, появилась возможность напрямую создавать tar.gz-архив контейнера. Это особенно полезно для более сложных рабочих процессов, где необходимы такие действия, как сканирование образов перед их отправкой. После создания архив можно передать, отсканировать или подключить к локальной установке Docker.

Чтобы выполнить архивирование во время публикации, добавьте свойство `ContainerArchiveOutputPath` в команду dotnet publish. Например:

```bash
dotnet publish \
  -p PublishProfile=DefaultContainer \
  -p ContainerArchiveOutputPath=./containers/my-container.tar.gz
```
