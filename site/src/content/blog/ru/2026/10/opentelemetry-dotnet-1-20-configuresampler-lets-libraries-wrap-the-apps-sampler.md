---
title: "OpenTelemetry .NET 1.20: ConfigureSampler позволяет библиотекам оборачивать сэмплер приложения"
description: "В OpenTelemetry .NET 1.20.0, вышедшем 15 октября 2026 года, появился метод TracerProviderBuilder.ConfigureSampler. Теперь библиотека может обернуть сэмплер, который SDK определил из SetSampler, OTEL_TRACES_SAMPLER или значения по умолчанию, вместо того чтобы молча его перезаписывать."
pubDate: 2026-10-19
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "tracing"
lang: "ru"
translationOf: "2026/10/opentelemetry-dotnet-1-20-configuresampler-lets-libraries-wrap-the-apps-sampler"
translatedBy: "claude"
translationDate: 2026-10-19
---

[OpenTelemetry .NET 1.20.0](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.20.0) вышел 15 октября 2026 года. Большая часть списка изменений посвящена исправлениям (утечка счётчика ссылок в `SuppressInstrumentationScope`, игнорирование `OTEL_SERVICE_NAME` в `ResourceBuilder.CreateDefault`, две гонки в метриках), но один новый API меняет то, как библиотекам и дистрибутивам следует работать с сэмплированием: `TracerProviderBuilder.ConfigureSampler`.

## SetSampler всегда работал по принципу "побеждает последний"

До версии 1.19.x повлиять на сэмплер трассировки можно было только через `SetSampler`. Сэмплер, заданный программно, приоритетнее переменной окружения `OTEL_TRACES_SAMPLER`, а та приоритетнее значения по умолчанию `ParentBased(AlwaysOnSampler)`. Для кода приложения такой порядок приоритетов подходит, но для библиотек он враждебен. Пакету, который хотел отбрасывать собственные шумные спаны, приходилось вызывать `SetSampler`, и в тот же момент настройка оператора `OTEL_TRACES_SAMPLER=traceidratio` игнорировалась с записью в журнал и выбрасывалась. Две библиотеки, делающие то же самое, молча конфликтовали: побеждала та, что зарегистрировалась последней.

## Что делает ConfigureSampler

[PR #7780](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7780) добавляет обратный вызов, который получает уже определённый SDK сэмплер и возвращает тот, который нужно использовать:

```csharp
public static TracerProviderBuilder ConfigureSampler(
    this TracerProviderBuilder tracerProviderBuilder,
    Func<IServiceProvider, Sampler, Sampler> configureSampler);
```

Правила, согласно XML-документации:

- Обратные вызовы выполняются после того, как SDK выберет сэмплер из `SetSampler`, `OTEL_TRACES_SAMPLER` или значения по умолчанию, независимо от того, зарегистрированы они до или после `SetSampler`.
- Каждый обратный вызов выполняется один раз, во время `Build()`. После этого сэмплер провайдера остаётся неизменяемым.
- Несколько обратных вызовов выстраиваются в цепочку в порядке регистрации, и каждый получает результат предыдущего.
- Возврат `null` или выброс исключения приводит к сбою сборки провайдера.

Поэтому библиотека может декорировать то, что настроило приложение, вместо того чтобы заменять это:

```csharp
public sealed class DropPollingSpansSampler(Sampler inner) : Sampler
{
    public override SamplingResult ShouldSample(in SamplingParameters parameters)
    {
        // The library's background poll loop creates a span every second.
        if (parameters.Name == "MyLibrary.Poll")
        {
            return new SamplingResult(SamplingDecision.Drop);
        }

        return inner.ShouldSample(parameters);
    }
}

public static class MyLibraryTracingExtensions
{
    public static TracerProviderBuilder AddMyLibrary(this TracerProviderBuilder builder) =>
        builder
            .AddSource("MyLibrary")
            .ConfigureSampler((_, resolved) => new DropPollingSpansSampler(resolved));
}
```

Если заданы `OTEL_TRACES_SAMPLER=traceidratio` и `OTEL_TRACES_SAMPLER_ARG=0.1`, приложение по-прежнему сэмплирует 10% трасс, а библиотека лишь отбрасывает свои спаны опроса перед этим решением. Замените переменную окружения явным `SetSampler(new AlwaysOnSampler())` в `Program.cs`, и обёртка подхватит и его, без игр с порядком регистрации.

## Нюанс с освобождением ресурсов

Провайдер освобождает только итоговый сэмплер. Если ваш обратный вызов отбрасывает полученный сэмплер или оборачивает его, время жизни внутреннего сэмплера остаётся на вашей ответственности. Для сэмплеров без состояния, таких как `TraceIdRatioBasedSampler`, это не имеет значения. Для всего, что держит таймер или соединение с удалённой конфигурацией, пробрасывайте `Dispose` из своей обёртки.

## Кому стоит перейти

Если вы поддерживаете библиотеку или внутренний дистрибутив, который сегодня вызывает `SetSampler`, перейдите на `ConfigureSampler`, чтобы больше не перекрывать конфигурацию оператора. Код приложения может продолжать использовать `SetSampler`, у него по-прежнему высший приоритет. В PR это также позиционируется как задел для сэмплирования с удалённым управлением и декларативной конфигурации, где выбор сэмплера полностью уходит из кода.

Обновляйте основные пакеты вместе, так как их версии меняются синхронно:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.20.0
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.20.0
```

Если вы пропустили предыдущий патч, [исправление wildcard-регулярного выражения в 1.19.1](/ru/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/) тоже включено.
