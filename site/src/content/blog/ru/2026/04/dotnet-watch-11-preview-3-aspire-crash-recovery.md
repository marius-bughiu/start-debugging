---
title: "dotnet watch в .NET 11 Preview 3: Aspire-хосты, crash recovery и вменяемый Ctrl+C"
description: "dotnet watch получает интеграцию с Aspire app host, автоматический перезапуск после крашей и починенную обработку Ctrl+C для Windows desktop-приложений в .NET 11 Preview 3."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "aspire"
  - "dotnet-watch"
lang: "ru"
translationOf: "2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery"
translatedBy: "claude"
translationDate: 2026-04-24
---

`dotnet watch` всегда был тихой рабочей лошадкой inner loop .NET. Он перезагружает ваше приложение, когда меняются файлы, применяет hot reload, где может, и убирается с дороги, где не может. .NET 11 Preview 3 (выпущен 14 апреля 2026) двигает инструмент вперёд по трём конкретным болевым точкам: запуск распределённых приложений, переживание крашей и обработка Ctrl+C на Windows desktop targets.

## Aspire app host теперь watch-ится чисто

До Preview 3 запуск Aspire app host под `dotnet watch` был неуклюжим. Aspire оркестрирует несколько дочерних проектов, и watcher не понимал эту модель, так что изменения файлов либо пересобирали только хост, либо заставляли всю топологию рестартовать с нуля.

Preview 3 разводит `dotnet watch` прямо в Aspire app model:

```bash
cd src/MyApp.AppHost
dotnet watch
```

Отредактируйте файл в `MyApp.ApiService`, и watcher теперь применит изменение только к этому сервису, оставив остаток топологии Aspire живым. Dashboard остаётся на месте, зависимые контейнеры продолжают работать, и вы теряете секунды boot time на каждое изменение вместо секунд на проект.

Для microservice-heavy solutions это разница между тем, чтобы `dotnet watch` был nice-to-have, и тем, чтобы он стал дефолтным способом работать.

## Автоматический перезапуск после краша

Второй заголовок - crash recovery. Раньше, когда ваше наблюдаемое приложение кидало необработанное исключение и умирало, `dotnet watch` парковался на сообщении о краше и ждал ручного рестарта. Если ваш следующий keystroke сохранял фикс, ничего не происходило до нажатия Ctrl+R.

В Preview 3 это поведение переворачивается. Возьмите endpoint, который взрывается:

```csharp
app.MapGet("/", () =>
{
    throw new InvalidOperationException("boom");
});
```

Дайте приложению крэшнуться раз, сохраните фикс, и `dotnet watch` автоматически перезапустится на следующем релевантном изменении файла. Вы не теряете feedback loop только из-за того, что приложение решило выйти non-zero. То же поведение покрывает краши на startup, которые раньше оставляли watcher заклинившим, до того как hot reload даже мог прикрепиться.

Это хорошо компонуется с watch-wide "rude edit" обработкой, которая уже существует: hot reload всё ещё пробует первым, падает на restart при неподдерживаемых правках, а теперь падает на restart и после краша тоже. Три пути, один консистентный исход: приложение возвращается.

## Ctrl+C на Windows desktop-приложениях

Третий фикс маленький, но был хроническим: Ctrl+C в `dotnet watch` для WPF и Windows Forms приложений. Раньше мог оставить desktop process сиротой, отсоединённым от watcher, или висящим в модальном окне. Preview 3 перепроводит обработку сигналов так, чтобы Ctrl+C сваливал и watcher, и desktop process по порядку, без zombie `dotnet.exe` записей, накапливающихся в Task Manager.

Если вы запускаете WPF shell под `dotnet watch`:

```bash
dotnet watch run --project src/DesktopShell
```

Ударьте Ctrl+C раз, и и shell, и watcher выходят чисто. Звучит базово, и так оно и есть, но предыдущее поведение было главной причиной, почему многие команды избегали `dotnet watch` на desktop-проектах полностью.

## Почему эти трое вместе важны

Каждое изменение само по себе скромное. В совокупности они перемещают `dotnet watch` из per-project хелпера в session-wide упряжь, которая может хостить Aspire-топологию целый день, впитывать редкий краш и убирать за собой, когда вы закончили. Inner loop стал заметно менее хрупким.

Release notes - в [блоге .NET](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/), а раздел SDK живёт в [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk).
