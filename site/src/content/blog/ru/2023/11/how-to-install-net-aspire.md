---
title: "Как установить Aspire CLI для AppHost на C#"
description: "Установка и проверка Aspire CLI для AppHost на C#. Почему команда dotnet workload install aspire относится к первоначальной предварительной версии для .NET 8."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "ru"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Для **AppHost на C#** в Aspire 13.x установите .NET 10 SDK и Aspire CLI. В терминале убедитесь, что в списке есть SDK 10.x, установите CLI как глобальный инструмент .NET и проверьте, что оболочка его находит:

```sh
dotnet --list-sdks
dotnet tool install --global Aspire.Cli
aspire --version
```

Если последняя команда не находит `aspire`, откройте терминал заново и проверьте, что каталог глобальных инструментов .NET входит в `PATH`. Способы установки через диспетчер пакетов Windows, Homebrew и другие варианты описаны в [руководстве по установке CLI](https://aspire.dev/get-started/install-cli/). Достаточно одного способа.

Если AppHost запускает Redis или базу данных в контейнере, понадобится работающая среда выполнения контейнеров. Подойдут Docker Desktop или Podman. В [требованиях Aspire](https://aspire.dev/get-started/prerequisites/) описана настройка среды и различие между SDK для AppHost на C# и целевыми платформами запускаемых служб.

## Почему в старых инструкциях устанавливают рабочую нагрузку Aspire

**Исправление — 2 ноября 2026 г.:** команду `dotnet workload install aspire` использовали в [предварительной версии для .NET 8 в ноябре 2023 года](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). Начиная с [Aspire 9 шаблоны поставляются в пакетах NuGet](https://aspire.dev/whats-new/aspire-9/), а рабочая нагрузка больше не требуется. Команда и снимки экрана ниже показывают прежнюю установку:

```sh
dotnet workload install aspire
```

В предварительной версии Visual Studio Installer предлагал необязательный компонент **.NET Aspire SDK (Preview)** в составе рабочей нагрузки веб-разработки. На втором снимке показан тогдашний установщик Docker Desktop для Windows.

[![Visual Studio Installer: выбрана нагрузка ASP.NET and web development и отмечен .NET Aspire SDK (Preview) в разделе Optional.](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

[![Установщик Docker Desktop: отмечены использование WSL 2 вместо Hyper-V и создание ярлыка на рабочем столе.](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Когда заработает `aspire --version`, [создайте стартовое приложение Aspire](/ru/2023/11/getting-started-with-net-aspire/). Роль AppHost объясняется в статье о том, [как Aspire связывает службы](/ru/2023/11/what-is-net-aspire/).
