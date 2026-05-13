---
title: "dotnet watch наконец добрался до MAUI на Android и iOS в .NET 11 Preview 4"
description: ".NET 11 Preview 4 включает dotnet watch для устройств Android, эмуляторов Android и симулятора iOS. Вы редактируете, сохраняете и запущенное приложение обновляется без ручной пересборки. Для iOS есть одна особенность csproj."
pubDate: 2026-05-13
tags:
  - "dotnet-11"
  - "maui"
  - "dotnet-watch"
  - "hot-reload"
  - "mobile"
lang: "ru"
translationOf: "2026/05/dotnet-watch-maui-android-ios-net-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-13
---

Microsoft [выпустила .NET 11 Preview 4 12 мая 2026 года](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), и для MAUI-разработчиков главный заголовок выглядит скромно в changelog, но огромен на практике: `dotnet watch` теперь управляет Hot Reload на устройствах Android, в эмуляторах Android и в симуляторе iOS. До этой предварительной версии мобильный цикл MAUI выглядел как "редактирование, пересборка, повторное развёртывание" для всего, что не относится к XAML. Preview 4 закрывает этот разрыв.

## Реальный рабочий процесс

Откройте MAUI-приложение, выберите target framework и устройство, и запустите:

```bash
dotnet watch --framework net11.0-android
```

Для iOS форма та же, с целью симулятора iOS:

```bash
dotnet watch --framework net11.0-ios
```

`dotnet watch` один раз развёртывает приложение, затем события изменения файлов транслируются в дельты Hot Reload и отправляются в работающий процесс. Тела методов C#, XAML и CSS все проходят через этот канал. Добавление новой `PackageReference` или `ProjectReference` посреди сессии также работает в .NET 11: Roslyn валидирует изменение, target `ReferenceCopyLocalPathsOutputGroup` копирует новые сборки в выходной каталог, а внутрипроцессный применитель дельт загружает их через событие `AssemblyResolving`. Без перезапуска.

## Особенность iOS, о которой нужно знать

Есть известная проблема, которую стоит закрепить у себя на доске. Согласно [release notes MAUI Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/dotnetmaui.md), `dotnet watch` не работает для проектов iOS, пока `MtouchLink` не отключён. Добавьте это в `PropertyGroup` для iOS в вашем `.csproj`:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <MtouchLink>None</MtouchLink>
</PropertyGroup>
```

Это отключает управляемый линкер для Debug-сборок iOS, что нормально для внутреннего цикла разработки, но в Release-конфигурации вам это не нужно. Держите условие ограниченным TFM iOS и Debug или перенесите его в условие `Debug|iPhoneSimulator`, если у вас отдельные конфигурации платформы.

Другие исправления, которые Preview 4 принёс на iOS-путь, стоят упоминания: конфликты ввода консоли с симулятором решены, исключение WebSocket, которое раньше убивало сессию Hot Reload, исчезло, а взаимная блокировка, замораживавшая приложение при быстрых правках, устранена. Это те самые баги, из-за которых прежние предварительные версии были непригодны на iOS, даже когда watch формально запускался.

## Почему это важнее, чем звучит

Цикл обратной связи MAUI был самой часто называемой причиной, по которой ветераны Xamarin и разработчики из мира Flutter держались в стороне. 30-секундная пересборка после каждой правки на C# убивает исследовательскую работу с UI. `dotnet watch` для десктопных целей (Windows, Mac Catalyst) существует уже давно, но именно мобильные платформы определяют судьбу MAUI. Preview 4 наконец выводит внутренний цикл MAUI на мобильных в ту же лигу, что и hot reload `flutter run`.

Если вы уже отслеживаете предварительные версии .NET 11 в отдельной ветке, эта именно та, которую стоит использовать в реальном проекте. Если вы ждали, [скачайте Preview 4](https://dotnet.microsoft.com/download/dotnet/11.0) и обновите свой iOS `.csproj` до первого запуска `dotnet watch`.
