---
title: "Спам запросов “become owner” в NuGet: что делать (и что закрыть) в .NET 9/.NET 10"
description: "Защитите свои .NET-пакеты от спама запросов на владение в NuGet. Lock-файлы, Package Source Mapping и практики Central Package Management для .NET 9 и .NET 10."
pubDate: 2026-01-23
tags:
  - "dotnet"
lang: "ru"
translationOf: "2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Ветка за последние 48 часов предупреждает о подозрительных запросах "become owner" на NuGet.org, якобы массово рассылаемых мейнтейнерам пакетов: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/).

Даже если детали к завтрашнему дню изменятся, защитный чек-лист стабилен. Цель проста: снизить вероятность того, что неожиданная смена владельца обернётся скомпрометированной зависимостью в ваших приложениях на .NET 9/.NET 10.

## Воспринимайте запросы на владение как событие безопасности, а не как уведомление

Если вы поддерживаете пакеты:

-   **Не принимайте** неожиданные приглашения в совладельцы, даже если отправитель выглядит "нормально".
-   **Проверяйте вне канала**: если вы узнаёте человека или организацию, свяжитесь по уже знакомому каналу (а не по самому приглашению).
-   **Сообщайте** о подозрительной активности в поддержку NuGet.org с метками времени и ID пакетов.

Если вы потребляете пакеты, исходите из того, что ошибки случаются, и делайте сборку устойчивой к сюрпризам со стороны upstream.

## Заблокируйте граф зависимостей, чтобы "сюрприз-обновления" не сами не прилетали

Если вы не используете lock-файлы, стоит начать. Lock-файлы делают restore детерминированными, а это именно то, что нужно, когда экосистема зависимостей шумит.

Включите lock-файлы в репозитории (работает с `dotnet restore`):

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
    <!-- Optional: make CI fail if the lock file would change -->
    <RestoreLockedMode Condition="'$(CI)' == 'true'">true</RestoreLockedMode>
  </PropertyGroup>
</Project>
```

Затем сгенерируйте начальный `packages.lock.json` один раз на проект (локально), закоммитьте его и пусть CI следит за его соблюдением.

## Уменьшите разрастание источников через Package Source Mapping

Частая ошибка это держать в игре "любой настроенный NuGet-источник". Package Source Mapping заставляет каждый шаблон ID пакета приходить из конкретного фида.

Минимальный пример `nuget.config`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="ContosoInternal" value="https://pkgs.dev.azure.com/contoso/_packaging/contoso/nuget/v3/index.json" />
  </packageSources>

  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="Microsoft.*" />
      <package pattern="System.*" />
      <package pattern="Newtonsoft.Json" />
    </packageSource>
    <packageSource key="ContosoInternal">
      <package pattern="Contoso.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
```

Теперь злоумышленник не сможет "выиграть", протолкнув одноимённый пакет в другой фид, о существовании которого вы забыли.

## Делайте обновления осознанными

Для кодовых баз на .NET 9 и .NET 10 лучшая повседневная позиция скучна:

-   Закрепляйте версии (или используйте Central Package Management) и обновляйтесь через PR.
-   Просматривайте diff'ы зависимостей как код-diff'ы.
-   Избегайте плавающих версий в продовых приложениях, если только у вас нет веской причины и сильного мониторинга.

Оригинальная ветка обсуждения здесь: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/). Если вы поддерживаете пакеты, стоит сегодня же проверить уведомления своего NuGet-аккаунта и провести аудит любых недавних смен владельцев.
