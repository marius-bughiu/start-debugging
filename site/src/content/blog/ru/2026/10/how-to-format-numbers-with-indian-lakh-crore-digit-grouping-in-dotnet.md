---
title: "Как форматировать числа с индийской группировкой разрядов lakh/crore в .NET (NumberGroupSizes)"
description: "Используйте культуру en-IN или задайте NumberFormatInfo.NumberGroupSizes равным [3, 2], чтобы в C# выводить 12,34,56,789 вместо 123,456,789. Замеры на .NET 10 и .NET 11 RC1: как работает массив, почему CurrencyGroupSizes задаётся отдельно, ловушка invariant globalization, которая молча выводит западную группировку, и вспомогательный метод для слов lakh/crore."
pubDate: 2026-10-18
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "globalization"
  - "formatting"
lang: "ru"
translationOf: "2026/10/how-to-format-numbers-with-indian-lakh-crore-digit-grouping-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Короткий ответ:** передайте культуру `en-IN` (или любую другую индийскую культуру, например `hi-IN`) в `ToString("N2", culture)`, и .NET выведет `12,34,56,789.50` вместо `123,456,789.50`, потому что в этих культурах уже заложено `NumberFormatInfo.NumberGroupSizes = [3, 2]`. Если нужна только группировка без остальных настроек культуры, клонируйте `NumberFormatInfo`, задайте `NumberGroupSizes = [3, 2]` (а также `CurrencyGroupSizes` и `PercentGroupSizes`, если вы используете `C` или `P`) и передайте его как провайдер формата. Массив означает: "первая группа справа содержит 3 цифры, каждая следующая группа содержит 2", и это работает для `int`, `long`, `decimal`, `double`, `BigInteger`, пользовательских шаблонов `#,##0` и `TryFormat`.

Все приведённые ниже результаты получены на .NET SDK 10.0.302 (среда выполнения 10.0.10) и на .NET 11 RC1 (`11.0.100-rc.1.26425.128`) на macOS с ICU, C# 14. Вывод побайтово совпал в обеих средах выполнения, а сам API `NumberGroupSizes` не менялся со времён .NET Framework 1.1, так что тот же код работает и на .NET 8 и 9.

## Чем индийская группировка отличается от западной

Западная конвенция группирует цифры по три: тысяча, миллион, миллиард. В индийской системе счисления первые три цифры (сотни) образуют одну группу, а дальше цифры группируются по две: тысяча, lakh (1,00,000), crore (1,00,00,000) и так далее. Так, сто двадцать три миллиона четыреста пятьдесят шесть тысяч семьсот восемьдесят девять в США записывается как `123,456,789`, а в Индии как `12,34,56,789` (12 crore, 34 lakh, 56 тысяч, 789).

.NET не зашивает ни одну из конвенций. Каждый `NumberFormatInfo` содержит три целочисленных массива, описывающих, как разбить целую часть числа на группы:

- `NumberGroupSizes` используется форматом `N` и пользовательскими шаблонами, содержащими `,`
- `CurrencyGroupSizes` используется форматом `C`
- `PercentGroupSizes` используется форматом `P`

Форматировщик проходит по этим массивам от десятичной точки влево. В этом и состоит весь механизм, и поэтому один массив способен описать обе конвенции.

## Минимальный пример: одно число, две культуры

```csharp
// .NET 11, C# 14 (also .NET 10.0.10)
using System.Globalization;

var us  = CultureInfo.GetCultureInfo("en-US");
var inr = CultureInfo.GetCultureInfo("en-IN");
decimal amount = 123456789.5m;

Console.WriteLine(string.Join(",", us.NumberFormat.NumberGroupSizes));  // 3
Console.WriteLine(string.Join(",", inr.NumberFormat.NumberGroupSizes)); // 3,2

Console.WriteLine(amount.ToString("N2", us));   // 123,456,789.50
Console.WriteLine(amount.ToString("N2", inr));  // 12,34,56,789.50
Console.WriteLine(amount.ToString("C", inr));   // ₹12,34,56,789.50
Console.WriteLine(12345.678.ToString("P1", inr)); // 12,34,567.8%
```

`hi-IN`, `bn-IN` и `ta-IN` сообщают одинаковые размеры `[3, 2]` для всех трёх массивов. Они также выводят ASCII-цифры: числовое форматирование .NET никогда не подставляет `NativeDigits`, поэтому вы получите `12,34,56,789`, а не цифры деванагари или бенгальского письма, какую бы индийскую культуру вы ни выбрали.

## Решение по шагам

Если ваше приложение уже работает с индийской культурой в качестве `CurrentCulture`, всё готово: `$"{amount:N2}"` подхватит группировку автоматически. Но чаще индийская группировка нужна на сервере с культурой `en-US` или инвариантной, либо для одного столбца в отчёте. Вот процедура, которая работает во всех случаях.

1. Решите, нужна ли вам вся индийская культура или только её группировка цифр. `en-IN` также приносит символ валюты `₹`, даты в стиле `dd-MM-yyyy` и индийские английские названия месяцев. Если нужны только запятые, создайте собственный `NumberFormatInfo`.
2. Начните с записываемой копии. `CultureInfo.GetCultureInfo(...)` и `CultureInfo.InvariantCulture` возвращают экземпляры только для чтения, и присваивание их свойствам `NumberFormat` выбрасывает `InvalidOperationException: Instance is read-only.` Вызовите `Clone()` у `NumberFormatInfo` или создайте культуру через `new CultureInfo("en-US")`, она доступна для записи.
3. Задайте размеры групп. Установите `NumberGroupSizes = [3, 2]` для `N` и пользовательских шаблонов. Если форматируете через `C` или `P`, задайте также `CurrencyGroupSizes` и `PercentGroupSizes`: это независимые массивы.
4. Заморозьте результат через `NumberFormatInfo.ReadOnly(nfi)` и храните его в поле `static readonly`, чтобы все вызывающие использовали один неизменяемый провайдер.
5. Передавайте его как `IFormatProvider` в `ToString`, `TryFormat`, `string.Format` или `string.Create`, либо задайте его как `CurrentCulture`, если весь поток должен использовать его.

В коде:

```csharp
// .NET 11, C# 14
using System.Globalization;

public static class IndianNumberFormat
{
    public static readonly NumberFormatInfo Grouping = Create();

    private static NumberFormatInfo Create()
    {
        var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
        nfi.NumberGroupSizes   = [3, 2];
        nfi.CurrencyGroupSizes = [3, 2];
        nfi.PercentGroupSizes  = [3, 2];
        nfi.CurrencySymbol     = "₹"; // invariant default is the generic ¤
        return NumberFormatInfo.ReadOnly(nfi);
    }
}

decimal amount = 123456789.5m;
Console.WriteLine(amount.ToString("N2", IndianNumberFormat.Grouping)); // 12,34,56,789.50
Console.WriteLine(amount.ToString("C",  IndianNumberFormat.Grouping)); // ₹12,34,56,789.50
```

Если пропустить шаг 3 для валюты, получится запутанная полумиграция. Когда изменён только `NumberGroupSizes`, `amount.ToString("C", nfi)` в моём тесте всё равно выводил `¤123,456,789.50`, потому что формат `C` читает `CurrencyGroupSizes`, который оставался равным `[3]`.

Чтобы изменить группировку для всего запроса или потока, не трогая язык всего остального, подправьте записываемую культуру:

```csharp
// .NET 11, C# 14
using System.Globalization;

var culture = new CultureInfo("en-US");          // writable, unlike GetCultureInfo
culture.NumberFormat.NumberGroupSizes = [3, 2];
CultureInfo.CurrentCulture = culture;

Console.WriteLine($"{123456789:N0}");            // 12,34,56,789
Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0:N0}", 123456789)); // 123,456,789
```

Вторая строка напоминает, что явно переданный провайдер всегда важнее `CurrentCulture`.

## Как интерпретируется массив NumberGroupSizes

Правила, проверенные на среде выполнения, а не принятые на веру:

- Элемент 0 задаёт размер группы, ближайшей к десятичной точке. Элемент 1 задаёт следующую группу слева, и так далее.
- **Последний элемент повторяется** для всех оставшихся групп. Поэтому `[3, 2]` бесконечно продолжает давать группы по две цифры.
- Если последний элемент равен `0`, оставшиеся цифры **вообще не группируются**.
- Каждый элемент должен лежать в диапазоне от 1 до 9, кроме последнего, который может быть равен 0. Любое другое значение выбрасывает `ArgumentException` с сообщением "Every element in the value array should be between one and nine, except for the last element, which can be zero."

Вот что разные массивы делают с числом `1234567890`:

```csharp
// .NET 11, C# 14
using System.Globalization;

var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
long n = 1234567890;

nfi.NumberGroupSizes = [3];       Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,890
nfi.NumberGroupSizes = [3, 2];    Console.WriteLine(n.ToString("N0", nfi)); // 1,23,45,67,890
nfi.NumberGroupSizes = [3, 0];    Console.WriteLine(n.ToString("N0", nfi)); // 1234567,890
nfi.NumberGroupSizes = [3, 2, 0]; Console.WriteLine(n.ToString("N0", nfi)); // 12345,67,890
nfi.NumberGroupSizes = [4];       Console.WriteLine(n.ToString("N0", nfi)); // 12,3456,7890
nfi.NumberGroupSizes = [1, 2, 3]; Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,89,0
nfi.NumberGroupSizes = [0];       Console.WriteLine(n.ToString("N0", nfi)); // 1234567890
nfi.NumberGroupSizes = [];        Console.WriteLine(n.ToString("N0", nfi)); // 1234567890

nfi.NumberGroupSizes = [3, 0, 2]; // ArgumentException: 0 is only allowed last
nfi.NumberGroupSizes = [10];      // ArgumentException: max is 9
```

`[4]` подходит для восточноазиатской группировки по десять тысяч (wan/man), если дизайн её требует; ни одна встроенная культура .NET по умолчанию её не использует. `[3, 0]` удобен, когда в спецификации сказано "разделять только тысячи".

Геттер возвращает копию массива. Запись `nfi.NumberGroupSizes[0] = 9` компилируется и выполняется, но ничего не меняет: в моём тесте вывод остался `12,34,56,789.50`. Всегда присваивайте новый массив.

## Какие форматы учитывают группировку, а какие нет

Я прогнал все распространённые пути с `en-IN`:

| Вызов | Результат |
|---|---|
| `1234567890123L.ToString("N0", inr)` | `12,34,56,78,90,123` |
| `amount.ToString("#,##0.00", inr)` | `12,34,56,789.50` |
| `BigInteger.Parse("123456789012345").ToString("N0", inr)` | `12,34,56,78,90,12,345` |
| `12345678f.ToString("N0", inr)` | `1,23,45,678` |
| `int.MinValue.ToString("N0", inr)` | `-2,14,74,83,648` |
| `123456789.TryFormat(span, out _, "N0", inr)` | `12,34,56,789` |
| `1234567.ToString("D", inr)` / `"G"` / `"F2"` | `1234567` / `1234567` / `1234567.89` |

Итак, `N`, `C`, `P` и пользовательские шаблоны с `,` следуют массивам, в том числе на пути `TryFormat` без выделений памяти. `D`, `G`, `F`, `E` и `ToString()` без параметров не группируют цифры ни в одной культуре.

Одна деталь пользовательских форматов сбивает с толку: положение запятой в пользовательском шаблоне не имеет значения. `123456789.ToString("#,##,##0", enUS)` выводит `123,456,789`, а не `12,34,56,789`. Запятая между заполнителями цифр лишь включает группировку; размеры всегда берутся из `NumberGroupSizes`. Получить индийскую группировку, написав "правильный" шаблон, нельзя. Нужно менять провайдер. Запятая непосредственно перед десятичной точкой (или в конце) это совсем другая возможность: каждая такая запятая делит число на 1000, так что `"0,,"` превращает `123456789` в `123`.

## Подводные камни

### Режим invariant globalization молча выводит западную группировку

Именно это попадает в продакшен. Многие образы контейнеров и приложения Native AOT задают `<InvariantGlobalization>true</InvariantGlobalization>` (или `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`), чтобы избавиться от зависимости от ICU. В этом режиме `CultureInfo.GetCultureInfo("en-IN")` выбрасывает `CultureNotFoundException: Only the invariant culture is supported in globalization-invariant mode.` Это по крайней мере заметно.

Тихий вариант возникает, когда кто-то дополнительно задаёт для `PredefinedCulturesOnly` значение `false` (`DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=0`), чтобы убрать это исключение. Тогда `new CultureInfo("en-IN")` успешно создаётся, но культура несёт инвариантные данные. Я измерил `sizes=3`, `123,456,789` из `N0` и `¤` в качестве символа валюты, без исключения и без предупреждения. Ваши индийские пользователи получают американские запятые.

Если вы строите `NumberFormatInfo` сами на основе `InvariantCulture`, как в классе `IndianNumberFormat` выше, группировка работает и в инвариантном режиме, потому что ничто не зависит от данных ICU. Это самый надёжный вариант для контейнеров. Если нужна полная культура `en-IN`, оставьте ICU в образе; [исправление ICU для контейнеров](/ru/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) разбирает нужные пакеты, а [сравнение вариантов развёртывания контейнеров](/ru/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) показывает, какие типы образов включают инвариантный режим.

### Точность по умолчанию у "N" непереносима

На этом Mac ICU сообщал `NumberDecimalDigits = 3` для `en-IN`, `hi-IN`, `en-US` и `en-GB`, поэтому `amount.ToString("N", inr)` выводил `12,34,56,789.500` с тремя знаками после запятой, тогда как `CurrencyDecimalDigits` оставался равным 2. В инвариантном режиме тот же вызов выводил два знака. Данные культур берутся из ICU операционной системы (или NLS в старых конфигурациях Windows), поэтому значение по умолчанию может отличаться на вашем ноутбуке и на сервере. Всегда указывайте точность явно: `N0`, `N2`, но никогда просто `N`, если результат видит пользователь или сравнивает тест.

### Разбор игнорирует позиции групп

`decimal.Parse("1,23,45,678.90", NumberStyles.Number, enUS)` возвращает `12345678.90`, как и `decimal.Parse("12,345,678", NumberStyles.Number, inr)`. С `NumberStyles.AllowThousands` .NET принимает разделители групп в любом месте целой части и не проверяет их по `NumberGroupSizes`. Это удобно, если нужно принимать оба стиля ввода, но означает, что разбор не является валидацией. Если для поля в индийском формате необходимо отклонять `12,345,678`, проверьте форму регулярным выражением, например `^\d{1,2}(,\d{2})*,\d{3}$|^\d{1,3}$`, до разбора.

### Другой разделитель

В индийских стилевых руководствах иногда просят тонкий пробел вместо запятой. Задайте `NumberGroupSeparator` (и `CurrencyGroupSeparator` для `C`) в том же клонированном `NumberFormatInfo`; я проверил `"\u202F"` (узкий неразрывный пробел) и получил `12 34 56 789` с прежними размерами. Используйте неразрывный пробел, чтобы число никогда не переносилось на другую строку.

## Вывод "12.35 lakh" и "2.5 crore"

`NumberGroupSizes` управляет разделителями, а не словами. В .NET нет встроенного компактного форматировщика, дающего "lakh" или "crore" (концепция `CompactDecimalFormat` есть в ICU, но через `ToString` не доступна). Небольшой вспомогательный метод закрывает типичную потребность UI:

```csharp
// .NET 11, C# 14
using System.Globalization;

static string ToLakhCrore(decimal value, int decimals = 2)
{
    var inr = CultureInfo.GetCultureInfo("en-IN");
    const decimal Lakh = 1_00_000m, Crore = 1_00_00_000m;
    decimal abs = Math.Abs(value);
    string sign = value < 0 ? "-" : "";
    string fmt = "#,##0." + new string('#', decimals);

    // Round in the target unit first, then promote if rounding crossed the boundary.
    decimal inLakh = Math.Round(abs / Lakh, decimals, MidpointRounding.AwayFromZero);
    if (abs >= Crore || inLakh >= 100m)
        return sign + Math.Round(abs / Crore, decimals, MidpointRounding.AwayFromZero).ToString(fmt, inr) + " crore";
    if (abs >= Lakh || inLakh >= 1m)
        return sign + inLakh.ToString(fmt, inr) + " lakh";
    return sign + abs.ToString(fmt, inr);
}

Console.WriteLine(ToLakhCrore(45_000m));         // 45,000
Console.WriteLine(ToLakhCrore(1_25_000m));       // 1.25 lakh
Console.WriteLine(ToLakhCrore(12_34_567m));      // 12.35 lakh
Console.WriteLine(ToLakhCrore(99_99_999m));      // 1 crore
Console.WriteLine(ToLakhCrore(2_50_00_000m));    // 2.5 crore
Console.WriteLine(ToLakhCrore(1234_56_78_901m)); // 1,234.57 crore
Console.WriteLine(ToLakhCrore(-3_50_000m));      // -3.5 lakh
```

Шаг "сначала округлить, затем повысить единицу" важен. Наивная версия, которая проверяет `abs >= Crore` до округления, выводит `100 lakh` для `99,99,999`, чего ни один индийский читатель не напишет. Обратите внимание на разделители цифр в литералах C# (`1_00_000m`): компилятор принимает `_` в любом месте между цифрами, так что для читаемости в исходном коде можно повторять индийскую группировку.

Если вспомогательный метод работает в контейнере с invariant globalization, замените `CultureInfo.GetCultureInfo("en-IN")` провайдером `IndianNumberFormat.Grouping` из примера выше, по причинам, описанным в подводном камне выше.

## Заметки о производительности

Размеры групп читаются один раз за вызов форматирования из массивов, уже лежащих в `NumberFormatInfo`, поэтому `[3, 2]` стоит столько же, сколько `[3]`. Дорогая ошибка это создание нового `CultureInfo` или клонирование `NumberFormatInfo` на каждый вызов. Кешируйте провайдер в поле `static readonly`, как показано выше, и используйте `TryFormat` в буфер на стеке при форматировании в горячем цикле; [сравнение StringBuilder и интерполяции](/ru/2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11/) показывает, сколько экономит путь без выделений памяти, когда вы собираете большие строки из многих чисел.

## Связанные материалы

- [Fix: Couldn't find a valid ICU package installed on the system in a .NET container](/ru/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/), если `en-IN` выбрасывает исключение в Docker.
- [Framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/ru/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/), чтобы узнать, где включается invariant globalization.
- [How to use Native AOT with ASP.NET Core minimal APIs](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), где по умолчанию включён инвариантный режим.
- [.NET 11 can round-trip a double as hex, bit for bit](/ru/2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat/), ещё один уголок числового форматирования и `NumberStyles`.

## Источники

- [NumberFormatInfo.NumberGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.numbergroupsizes) на Microsoft Learn.
- [NumberFormatInfo.CurrencyGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.currencygroupsizes) на Microsoft Learn.
- [Standard numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-numeric-format-strings) и [custom numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/custom-numeric-format-strings), включая разделитель групп и спецификатор масштабирования числа.
- [Globalization and ICU in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu).
- [Culture creation and case mapping in globalization-invariant mode](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode), изменение .NET 6, которое ввело `PredefinedCulturesOnly`.
