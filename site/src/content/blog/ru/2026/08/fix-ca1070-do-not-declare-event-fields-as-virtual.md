---
title: "Fix: CA1070 \"Do not declare event fields as virtual\""
description: "CA1070 срабатывает на полеподобных событиях с модификатором virtual. Уберите virtual, оставьте событие невиртуальным и дайте наследникам метод protected virtual OnXxx."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "analyzers"
  - "events"
lang: "ru"
translationOf: "2026/08/fix-ca1070-do-not-declare-event-fields-as-virtual"
translatedBy: "claude"
translationDate: 2026-08-29
---

CA1070 срабатывает, когда полеподобное событие несёт модификатор `virtual`. Исправление состоит в том, чтобы убрать `virtual` и дать производным классам метод-инициатор `protected virtual void OnThresholdReached(...)`, который можно переопределить. Это не придирка к стилю: если это виртуальное событие кто-нибудь переопределит, компилятор выдаст базовому и производному классу два отдельных приватных поля-хранилища, и вызов из базового класса молча не сделает ничего.

Текст диагностики, который вы ищете:

```text
warning CA1070: Event 'ThresholdReached' should not be declared virtual
```

Всё изложенное ниже проверено на SDK `10.0.302` (.NET 10, C# 14) с анализаторами, входящими в состав SDK, и сверено с исходным кодом `DoNotDeclareEventFieldsAsVirtual` в `dotnet/sdk`.

## Сообщает ли dotnet build о CA1070?

Нет. Уровень серьёзности по умолчанию у правила не предупреждение, а подсказка, потому что анализатор объявлен с `RuleLevel.IdeSuggestion`:

```csharp
// dotnet/sdk, Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs
internal static readonly DiagnosticDescriptor Rule = DiagnosticDescriptorHelper.Create(
    RuleId,
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualTitle)),
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualMessage)),
    DiagnosticCategory.Design,
    RuleLevel.IdeSuggestion,
    ...
```

Диагностики уровня подсказки видны в Visual Studio, Rider и `dotnet format`, но `dotnet build` их не печатает, а `TreatWarningsAsErrors` их не затрагивает. Проект, полный виртуальных событий, собирается так:

```text
    0 Warning(s)
    0 Error(s)
```

Два способа сделать правило действующим:

```xml
<!-- .NET 10 SDK 10.0.302: promotes the All-mode analyzers, CA1070 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
```

Это та же ловушка невидимости, что и у [CA1873 с дорогими аргументами логирования](/ru/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/), а компромиссы при повышении подсказок в CI разобраны в статье [TreatWarningsAsErrors без вреда для сборок разработчика](/ru/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).

## Почему событие вообще помечают как virtual?

Почти всегда из-за CS0070. Производный класс не может вызвать событие базового класса:

```csharp
// .NET 10, C# 14
public class Sensor
{
    public event EventHandler? ThresholdReached;
}

public class LoggingSensor : Sensor
{
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}
```

```text
error CS0070: The event 'Sensor.ThresholdReached' can only appear on the left hand side
of += or -= (except when used from within the type 'Sensor')
```

Компилятор говорит вам, что за пределами объявляющего типа событие представляет собой только пару add/remove, но никак не стоящий за ним делегат. Кажущийся очевидным выход состоит в том, чтобы пометить событие как `virtual` и переопределить его в `LoggingSensor`, чтобы имя разрешалось в нечто принадлежащее производному классу. Это компилируется. И это же ломает событие.

## Почему переопределение виртуального полеподобного события ломает событие?

Базовый класс перестаёт вызывать обработчики. Вот вся неисправность целиком в одном файле:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
using System;

public class Sensor
{
    public virtual event EventHandler? ThresholdReached;   // CA1070
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached;
    public void RaiseFromDerived() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public static class Program
{
    public static void Main()
    {
        LoggingSensor derived = new();
        Sensor asBase = derived;
        asBase.ThresholdReached += (_, _) => Console.WriteLine("handler ran");

        Console.WriteLine("Sensor.Raise():");
        asBase.Raise();                 // fires nothing
        Console.WriteLine("LoggingSensor.RaiseFromDerived():");
        derived.RaiseFromDerived();     // fires the handler
    }
}
```

Реальный вывод на .NET 10:

```text
Sensor.Raise():
LoggingSensor.RaiseFromDerived():
handler ran
```

Тот же объект, тот же обработчик: один вызов работает, а другой не делает ничего.

Причина в том, что полеподобное событие одновременно является двумя разными сущностями, и виртуальна только одна из них. Аксессоры `add` и `remove` являются настоящими методами и модификатор `virtual` действительно получают. Поле-делегат, стоящее за событием, его не получает, поскольку поля не могут быть виртуальными. Рефлексия по скомпилированной сборке показывает ровно то, что выдал компилятор:

```text
Sensor: field ThresholdReached, IsPrivate=True, type=EventHandler
Sensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=Sensor
LoggingSensor: field ThresholdReached, IsPrivate=True, type=EventHandler
LoggingSensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=LoggingSensor
```

Два приватных поля, по одному на тип. Отсюда следует:

- `asBase.ThresholdReached += handler` проходит через виртуальный аксессор add, диспетчеризуется в `LoggingSensor.add_ThresholdReached` и попадает в поле класса `LoggingSensor`.
- `Sensor.Raise()` не проходит ни через какой аксессор. Внутри объявляющего типа `ThresholdReached?.Invoke(...)` компилируется в обычное чтение собственного приватного поля класса `Sensor`, которое по-прежнему равно null.

Спецификация C# это допускает. Объявление виртуального события делает виртуальными аксессоры, а переопределяющее объявление события "не объявляет новое событие, оно лишь специализирует реализации аксессоров". Формулировка спецификации подразумевает, что производные аксессоры должны специализировать доступ к одному общему полю, а для этого компилятору пришлось бы повысить поле-хранилище базового класса с приватного до защищённого. Он никогда этого не делал. Microsoft задокументировала это как известную ошибку компилятора ещё в 2007 году и решила её не исправлять, поскольку исправление воскресило бы вызовы обработчиков в коде, который молча полагался на то, что они никогда не срабатывают.

С 2007 года изменилось то, что сбой стал тише. В исходном примере использовался вызов `myEvent(this, null)`, который выбрасывал `NullReferenceException` и хотя бы указывал на проблему. Современный вызов через null-условный оператор, к которому вас подталкивают все анализаторы и автоисправления, превращает это в молчаливое бездействие.

## Как это проявляется в базовом классе MVVM?

Форма, к которой прибегают при написании `INotifyPropertyChanged` в базовой модели представления, и есть в точности сломанный случай:

```csharp
// .NET 10, C# 14
public class ViewModelBase : INotifyPropertyChanged
{
    public virtual event PropertyChangedEventHandler? PropertyChanged;   // CA1070
    protected void Notify(string n) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

public class OrderViewModel : ViewModelBase
{
    public override event PropertyChangedEventHandler? PropertyChanged;
}
```

Механизм привязки подписывается через интерфейс `INotifyPropertyChanged`, что ведёт к виртуальному аксессору add, который сохраняет обработчик в `OrderViewModel`. Метод `Notify` выполняется внутри `ViewModelBase` и читает поле класса `ViewModelBase`. Я подтвердил на .NET 10, что обработчик не вызывается никогда: интерфейс просто не обновляется, без исключения и без ошибки привязки в окне вывода.

Модификатор `override` в производной модели представления обычно рудиментарен, добавлен кем-то в погоне за CS0070 или скопирован из шаблона. Его удаление чинит привязку мгновенно, потому что поле-хранилище тогда остаётся одно. Это стоит проверить, прежде чем что-либо переписывать. Если вы строите механизм уведомлений с нуля, [генератор исходного кода для INotifyPropertyChanged](/ru/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) выдаёт правильную невиртуальную форму и никогда здесь не ошибается.

## Как исправить CA1070?

В порядке предпочтения.

**1. Невиртуальное событие плюс защищённый виртуальный метод-инициатор.** Это тот шаблон, который предписывают рекомендации по проектированию .NET, и именно к нему подталкивает CA1070. Производные классы получают точку расширения, которая им и была нужна, а поле-хранилище остаётся ровно одно.

```csharp
// .NET 10, C# 14. Builds clean under AnalysisMode=All.
public class Sensor
{
    public event EventHandler? ThresholdReached;

    protected virtual void OnThresholdReached(EventArgs e)
        => ThresholdReached?.Invoke(this, e);

    public void Raise() => OnThresholdReached(EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    protected override void OnThresholdReached(EventArgs e)
    {
        Console.WriteLine("[derived saw the raise]");
        base.OnThresholdReached(e);
    }
}
```

Учтите, что метод-инициатор читает поле, поэтому он должен находиться в объявляющем типе. Переопределения в наследниках вызывают `base.OnThresholdReached(e)`, чтобы событие действительно сработало. Забыв вызов `base`, вы подавите событие, что иногда как раз и требуется.

**2. Оставить событие виртуальным, но написать явные аксессоры поверх защищённого поля.** Так стоит поступать, когда производному классу действительно нужно перехватывать подписку, например чтобы отложенно подключить хук операционной системы на первом подписчике. CA1070 здесь не срабатывает, поскольку правило нацелено только на полеподобные события.

```csharp
// .NET 10, C# 14
public class Sensor
{
    protected EventHandler? _thresholdReached;

    public virtual event EventHandler? ThresholdReached
    {
        add => _thresholdReached += value;
        remove => _thresholdReached -= value;
    }

    public void Raise() => _thresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached
    {
        add { Console.WriteLine("[derived add]"); _thresholdReached += value; }
        remove => _thresholdReached -= value;
    }
}
```

Операция `+=` над полем-делегатом не атомарна, поэтому используйте `Interlocked.CompareExchange` или блокировку в аксессорах, если подписчики могут приходить из нескольких потоков. В моём запуске оба обработчика сработали корректно, поскольку теперь оба аксессора обращаются к одному и тому же защищённому полю.

**3. Сделать событие базового класса abstract.** Абстрактное полеподобное событие нельзя использовать как поле, поэтому базовый класс физически не может его вызвать и ошибка с разделёнными полями возникнуть не может. CA1070 не срабатывает, поскольку анализатор проверяет `IsVirtual`, а для абстрактных членов это значение равно false.

```csharp
// .NET 10, C# 14
public abstract class Sensor
{
    public abstract event EventHandler? ThresholdReached;
    public abstract void Raise();
}
```

Это правильно, но нужно редко, поскольку теперь каждому производному классу приходится заново реализовывать и событие, и его вызов.

## Какие объявления CA1070 действительно помечает?

Только объявление `virtual` в базовом классе, что удивляет тех, кто запускает анализатор в расчёте, что он укажет на действительно сломанную строку. Проверка представляет собой единственное действие над символом:

```csharp
// dotnet/sdk, DoNotDeclareEventFieldsAsVirtual.cs
if (!eventSymbol.IsVirtual ||
    eventSymbol.AddMethod?.IsImplicitlyDeclared == false ||
    eventSymbol.RemoveMethod?.IsImplicitlyDeclared == false)
{
    return;
}
```

Свойство `IEventSymbol.IsVirtual` равно true только для членов, объявленных с ключевым словом `virtual`. Член с `override` сообщает `IsOverride`, а не `IsVirtual`, а член с `abstract` сообщает `IsAbstract`. Поэтому диагностика приходится на объявление в базовом классе и больше никуда. Проверки `IsImplicitlyDeclared` как раз и ограничивают правило полеподобными событиями: если аксессоры написали вы сами, они не являются неявными и правило отступает.

Вот полная матрица, которую я собрал и прогнал на SDK 10.0.302 с настройкой `dotnet_diagnostic.CA1070.severity = warning`:

| Объявление | CA1070? |
| --- | :---: |
| `public virtual event EventHandler A;` | да |
| `protected virtual event EventHandler B;` в открытом незапечатанном классе | да |
| `internal virtual event EventHandler C;` | нет |
| `public virtual event EventHandler D { add {} remove {} }` | нет |
| `public override event EventHandler A;` в производном классе | нет |
| `public abstract event EventHandler E;` | нет |
| `public virtual event EventHandler F;` внутри класса `internal` | нет |
| `public event EventHandler G;` (не виртуальное) | нет |

Две строки, которые сбивают людей с толку, относятся к внутренним объявлениям, и их поведение настраивается.

## Как заставить CA1070 охватывать internal- и private-события?

По умолчанию правило анализирует только внешне видимые символы, повторяя старое поведение FxCop. Расширьте охват через `api_surface`:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
dotnet_code_quality.CA1070.api_surface = all
```

На той же матрице `api_surface = all` сообщает про A, B, C и F. Настройка `api_surface = private, internal` сообщает только про C и F. Для сборки приложения, а не публикуемой библиотеки, правильным значением будет `all`: там ничто не является контрактом открытого API, а самой ошибке уровень доступа безразличен.

Стоит знать об одном расхождении в документации: страница MS Learn указывает в качестве применимых языков "C# and Visual Basic", однако анализатор помечен атрибутом `[DiagnosticAnalyzer(LanguageNames.CSharp)]` с комментарием подавления "Construct is invalid in VB.NET". В VB полеподобного события `Overridable` нет в принципе, так что анализировать нечего; таблица в документации попросту устарела.

## Когда безопасно подавить CA1070?

Когда виртуальное событие уже является частью выпущенного открытого API. Удаление `virtual` представляет собой двоичное несовместимое изменение для всех, кто его переопределил, поэтому рекомендация самого правила состоит в том, чтобы подавить предупреждение, а не ломать потребителей. Подавляйте его на объявлении, а не на уровне проекта, и оставьте пояснение:

```csharp
// Public since v2.0. Removing 'virtual' is a binary break for derived types.
#pragma warning disable CA1070
public virtual event EventHandler? ThresholdReached;
#pragma warning restore CA1070
```

После этого всё равно добавьте защищённый метод-инициатор, чтобы у новых производных типов была корректная точка расширения и они перестали тянуться к `override`. В новой или внутренней кодовой базе не подавляйте предупреждение. Исправьте его.

## Подводные камни и похожие ошибки, приводящие сюда по ошибке

**CS0070** ("The event 'X' can only appear on the left hand side of += or -=") представляет собой ошибку компиляции, которая и подталкивает людей писать `virtual`, о чём говорилось выше. Исправлением служит защищённый метод-инициатор, но никак не виртуальное событие.

**CS0067** ("The event 'X' is never used") появляется на производном `override`, как только вы последуете этой статье и перестанете вызывать событие из производного класса. Это предупреждение представляет собой видимый анализатору призрак поля-хранилища, в которое никто не пишет; удаление переопределения его устраняет.

**CA1030** ("Use events where appropriate") и **CA1003** ("Use generic event handler instances") являются правилами проектирования о форме событий, а не о виртуальности, и ни одно из них не имеет отношения к ошибке с разделёнными полями.

**"Я пометил его virtual, чтобы Moq или Castle DynamicProxy могли его перехватить."** Библиотекам мокирования на основе прокси виртуальные члены действительно нужны, и перехват событий представляет собой единственный случай, когда уступка им закладывает настоящую ошибку. Мокируйте вместо этого интерфейс: выделите `IThresholdSource` с обычным `event EventHandler ThresholdReached` и позвольте моку его реализовать, тогда `virtual` не понадобится нигде. То же относится к базовому классу, целиком помеченному как виртуальный ради прокси отложенной загрузки EF Core, где на деле это нужно только навигационным свойствам.

Если виртуальное событие уже выпущено и вы разбираете последствия, симптомом обычно служит обработчик, который остаётся подписанным навсегда и при этом никогда не вызывается, и который виден как укоренённый делегат в дампе кучи. Статья [Диагностика утечки управляемой памяти с помощью dotnet-gcdump и dotnet-dump](/ru/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) разбирает, как найти уцелевшую цепочку обработчиков.

CA1070 входит в поставку со времён анализаторов .NET 5, с уровнем Info, и никогда не повышалось. Для правила, чей заряд детонирует только когда кто-то напишет `override`, это справедливое решение, но оно означает, что предупреждение, которое с наибольшей вероятностью сэкономит вам вечер размышлений о том, почему не обновляется привязка, ваша сборка не печатает никогда. Превратить его в предупреждение стоит одной строки в `.editorconfig`.

## Связанное

- [Fix: CA1873 "Evaluation of this argument may be expensive and unnecessary if logging is disabled"](/ru/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/)
- [Как написать генератор исходного кода для INotifyPropertyChanged](/ru/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/)
- [TreatWarningsAsErrors без вреда для сборок разработчика (.NET 10)](/ru/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [Что такое генератор исходного кода и когда он нужен?](/ru/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [Как диагностировать утечку управляемой памяти с помощью dotnet-gcdump и dotnet-dump](/ru/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)

## Источники

- [CA1070: Do not declare event fields as virtual](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1070) на MS Learn
- [DoNotDeclareEventFieldsAsVirtual.cs](https://github.com/dotnet/sdk/blob/main/src/Microsoft.CodeAnalysis.NetAnalyzers/src/Microsoft.CodeAnalysis.NetAnalyzers/Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs), исходный код анализатора
- [Virtual events in C#](https://learn.microsoft.com/en-us/archive/blogs/samng/virtual-events-in-c), публикация команды C# от 2007 года, где задокументированы ошибка компилятора и решение её не исправлять
- [How to raise base class events in derived classes](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/events/how-to-raise-base-class-events-in-derived-classes) на MS Learn
- [Handle and raise events](https://learn.microsoft.com/en-us/dotnet/standard/events/), рекомендации по проектированию событий в .NET
- [Compiler Error CS0070](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0070) на MS Learn
- [Параметр конфигурации api_surface](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/code-quality-rule-options#api_surface) для правил качества кода
