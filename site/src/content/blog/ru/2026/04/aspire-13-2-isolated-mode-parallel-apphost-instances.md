---
title: "Aspire 13.2 --isolated: запускайте параллельные экземпляры AppHost без конфликтов портов"
description: "Aspire 13.2 поставляет флаг --isolated, дающий каждому aspire run свои случайные порты и store secrets. Разблокирует multi-checkout работу, worktree-агенты и интеграционные тесты, требующие живой AppHost."
pubDate: 2026-04-18
tags:
  - "aspire"
  - "dotnet-11"
  - "dotnet"
  - "tooling"
lang: "ru"
translationOf: "2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances"
translatedBy: "claude"
translationDate: 2026-04-24
---

Запуск двух копий одного и того же Aspire-приложения одновременно всегда означал драку с `address already in use`. Aspire 13.2, [анонсированный на этой неделе](https://devblogs.microsoft.com/aspire/aspire-13-2-announcement/), добавляет маленький, но полезный флаг, убирающий драку: `--isolated`. Каждый запуск получает свои случайные порты, свой user secrets store и свой dashboard URL, так что два AppHost могут жить бок о бок без ручного port remapping.

## Откуда приходили конфликты

По умолчанию `aspire run` привязывается к фиксированным портам: dashboard на 18888, OTLP на 4317/4318, и предсказуемые bindings на каждый ресурс. Это нормально для одного разработчика на одной ветке. Как только вы добавляете второй worktree, coding-агент, поднимающий ещё один экземпляр, или интеграционный тест, желающий живой AppHost, всё конфликтует. Команды латали это твиками `launchSettings.json` или кастомными port map, и ничего из этого не композируется.

## Что `--isolated` реально меняет

`--isolated` у `aspire run` или `aspire start` делает две вещи за один запуск. Во-первых, каждый порт, который обычно привязывался бы к фиксированному номеру (dashboard, OTLP, endpoints ресурсов), привязывается вместо этого к случайному свободному порту. Service discovery подхватывает динамические значения, так что само приложение не должно знать, что выбрали его собратья. Во-вторых, backing store user secrets ключуется по instance ID, уникальному для запуска, так что connection strings и API keys не протекают между параллельными AppHost.

Типичный workflow из двух веток теперь выглядит так:

```bash
# Terminal 1 - feature branch worktree
cd ~/src/my-app-feature
aspire run --isolated

# Terminal 2 - bug fix worktree
cd ~/src/my-app-bugfix
aspire run --isolated
```

Оба процесса поднимаются, оба dashboard доступны на разных URL, и ни один не знает и не заботится о другом. Выключение одного не возмущает резервирование портов другого.

## Почему это важно за пределами "нескольких терминалов"

Более интересный потребитель - tooling. [Detached режим](https://devblogs.microsoft.com/aspire/aspire-detached-mode-and-process-management/) позволяет coding-агенту стартовать AppHost с `--detach` и вернуть терминал. В сочетании с `--isolated` тот же агент может поднять N AppHost через N git worktree параллельно, прогнать HTTP probes или интеграционные тесты против каждого и снести их - без ручной бухгалтерии по портам. Это тот паттерн, который background-агенты VS Code уже используют, создавая worktree для exploratory работы.

Сьюты интеграционных тестов получают тот же бенефит. Раньше запуск AppHost из `dotnet test` в CI, пока разработчик держал приложение открытым локально, требовал environment override. С `--isolated` test fixture может просто сделать:

```csharp
[Fact]
public async Task ApiReturnsHealthy()
{
    var apphost = await DistributedApplicationTestingBuilder
        .CreateAsync<Projects.MyApp_AppHost>(["--isolated"]);

    await using var app = await apphost.BuildAsync();
    await app.StartAsync();

    var client = app.CreateHttpClient("api");
    var response = await client.GetAsync("/health");

    response.StatusCode.Should().Be(HttpStatusCode.OK);
}
```

Без статической port map, без очистки между test runs, без сюрпризов "я приложение оставил запущенным?".

## В паре с --detach и aspire wait

Полный agent-friendly loop в 13.2 выглядит как `aspire run --isolated --detach`, чтобы стартовать в фоне, `aspire wait api --status healthy --timeout 120`, чтобы блокировать до подъёма ресурса, и `aspire resource api restart`, чтобы циклить куски без сноса всего графа. `--isolated` - это кусок, делающий эти loops композируемыми по N копиям.

Полный список CLI-дополнений 13.2 см. в [документации isolated mode](https://devblogs.microsoft.com/aspire/aspire-isolated-mode-parallel-development/).
