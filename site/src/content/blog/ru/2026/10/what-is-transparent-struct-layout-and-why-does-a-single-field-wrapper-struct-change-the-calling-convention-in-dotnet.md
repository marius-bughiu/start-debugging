---
title: "Что такое transparent-раскладка структуры и почему структура-обёртка с одним полем меняет соглашение о вызовах в .NET?"
description: "Transparent-структура - это структура, которую ABI обрабатывает точно так же, как её единственное поле. В .NET 11 такой гарантии нет: структура, оборачивающая double, передаётся в RCX в Windows x64, но в XMM0 в Linux и macOS. Здесь разобран дизассемблированный код JIT-компилятора .NET 11 для трёх ABI, ошибки P/Invoke, которые из этого возникают, и способы писать типы-обёртки, безопасные на любой границе."
pubDate: 2026-10-10
tags:
  - "dotnet-11"
  - "csharp"
  - "interop"
  - "jit"
  - "performance"
lang: "ru"
translationOf: "2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-10
---

Короткий ответ: "transparent layout" - это гарантия того, что структура ровно с одним полем размещается в памяти *и передаётся при вызовах* точно так же, как это поле. В Rust это записывается как `#[repr(transparent)]`. В .NET 11 такой гарантии нет. Структура C# вроде `readonly record struct Meters(double Value)` имеет ту же 8-байтовую раскладку в памяти, что и `double`, но на границе вызова JIT классифицирует её как агрегат, а то, как агрегаты передаются, решает ABI каждой платформы. В Linux x64, macOS x64 и на всех целях ARM64 обёртка по-прежнему передаётся в регистре с плавающей точкой, поэтому вы ничего не замечаете. В Windows x64 она передаётся в `RCX`, то есть в целочисленном регистре, а возвращается в `RAX`, а не в `XMM0`. В управляемом коде это стоит пары перемещений между регистрами, а если использовать обёртку в сигнатуре P/Invoke, где нативная сторона принимает обычный `double`, значения молча портятся.

Всё ниже запускалось на .NET 11 RC1 (среда выполнения 11.0.0-rc.1.26425.128, SDK 11.0.100-rc.1.26425.128) с C# 15. Управляемый дизассемблированный код для Windows x64 и Linux x64 получен кросс-компилятором `crossgen2` из RC1 с `JitDisasm`, листинги для macOS получены запуском приложения нативно на arm64 и под Rosetta на x64, а нативные листинги получены из Apple clang 21 для каждого ABI.

## Раскладка в памяти и соглашение о вызовах - это два разных контракта

Когда говорят, что структура с одним полем "бесплатна", обычно имеют в виду раскладку в памяти. Это верно. `Meters` занимает 8 байт с выравниванием 8, как и `double`. `Unsafe.SizeOf<Meters>()` возвращает 8, массив `Meters` побитово совместим с массивом `double`, а `MemoryMarshal.Cast<Meters, double>` работает.

Соглашение о вызовах - отдельный контракт. Он отвечает на вопрос: если это значение является аргументом или возвращаемым значением, какой регистр или слот стека его хранит? ABI принимает это решение, *классифицируя* тип, и большинство ABI сначала определяют, скаляр это или агрегат, и только потом заглядывают внутрь. Структура является агрегатом, даже если у неё одно поле. Будет ли ABI после этого смотреть сквозь неё на `double` внутри, целиком зависит от платформы:

- **System V AMD64 (Linux x64, macOS x64)** разбивает агрегаты на eightbyte и классифицирует каждый по содержащимся в нём полям. Одно поле `double` означает, что eightbyte относится к классу SSE, поэтому структура передаётся в `XMM0`, так же как и простой `double`.
- **AAPCS64 (Linux, macOS и Windows на ARM64)** содержит правило однородного агрегата с плавающей точкой (HFA): структура из одного-четырёх полей одного и того же типа с плавающей точкой передаётся в последовательных SIMD-регистрах. Один `double` - это HFA размера один, поэтому он передаётся в `D0`, как и простой `double`.
- **Windows x64** вообще не заглядывает внутрь. В [документации по соглашению о вызовах x64](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention) сказано, что структуры размером 8, 16, 32 или 64 бита "передаются так, как если бы это были целые числа того же размера". Структура с одним `double` занимает 64 бита, поэтому она передаётся в `RCX`. При возврате пользовательский тип подходящего размера возвращается в `RAX`, а `float` и `double` возвращаются в `XMM0`.

JIT-компилятор .NET следует ABI платформы при вызовах между управляемыми методами, а не только для P/Invoke. Так что это не особенность одного лишь взаимодействия с нативным кодом. Она проявляется и в обычном коде C#.

## Нативный ABI прямо из компилятора

Вот самый маленький файл на C, который показывает разницу. Компиляция для трёх целей с `clang -O2 -S` показывает, чего ожидает каждый ABI:

```c
// abi.c, Apple clang 21, -O2
typedef struct { double value; } Meters;
typedef struct { float x, y; } Vec2;

double take_double(double d) { return d * 2.0; }
double take_meters(Meters m) { return m.value * 2.0; }
Meters ret_meters(double d) { Meters m = { d }; return m; }
float  take_vec2(Vec2 v) { return v.x + v.y; }
float  take_two_floats(float x, float y) { return x + y; }
```

Для `x86_64-pc-windows-msvc`:

```asm
; Windows x64
take_double:
    addsd   %xmm0, %xmm0      ; double arrives in xmm0
    retq
take_meters:
    movq    %rcx, %xmm0       ; Meters arrives in rcx, moved to xmm0 first
    addsd   %xmm0, %xmm0
    retq
ret_meters:
    movq    %xmm0, %rax       ; Meters is returned in rax, not xmm0
    retq
```

Для `x86_64-apple-macos` (System V) и `arm64-apple-macos` (AAPCS64) `take_meters` компилируется в точно такие же инструкции, как и `take_double` (`addsd %xmm0, %xmm0` и `fadd d0, d0, d0` соответственно), а `ret_meters` компилируется в голую `ret`, потому что значение уже находится в регистре возврата.

Получается, что на двух из трёх ABI обёртка прозрачна по случайности из-за правил классификации, а на Windows x64 непрозрачна.

## Что JIT .NET 11 генерирует для структуры-обёртки

Теперь управляемая сторона. Два метода, отличающиеся только обёрткой:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.CompilerServices;

public readonly record struct Meters(double Value);

static class Managed
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static double ScaleDouble(double d) => d * 2.0;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static Meters ScaleMeters(Meters m) => new(m.Value * 2.0);
}
```

В Linux x64 (crossgen2 `--targetos:linux --targetarch:x64`) оба метода компилируются в одни и те же 5 байт:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, linux-x64
       vaddsd   xmm0, xmm0, xmm0
       ret
; Total bytes of code 5
```

В macOS arm64 при нативном запуске с `DOTNET_JitDisasm` оба метода занимают одинаковые 20 байт, а единственная реальная работа - `fadd d0, d0, d0`.

В Windows x64 (crossgen2 `--targetos:windows --targetarch:x64`) `ScaleDouble` по-прежнему занимает 5 байт, а `ScaleMeters` превращается в следующее:

```asm
; Managed:ScaleMeters(Meters):Meters, .NET 11 RC1, win-x64
       vmovq    xmm0, rcx          ; argument arrives in an integer register
       vaddsd   xmm0, xmm0, xmm0
       vmovq    rax, xmm0          ; result leaves in an integer register
       ret
; Total bytes of code 15
```

Два лишних перемещения между доменами регистров на каждый вызов и втрое больший размер кода. Внутри тела метода JIT заменяет структуру её единственным полем и работает с обычным регистром `double`; вся цена платится на границе. Если вызов встраивается, граница исчезает, а вместе с ней и цена. Поэтому накладные расходы редко имеют значение на практике и заметны только на горячих путях без встраивания: в виртуальных вызовах, при диспетчеризации через интерфейсы, в делегатах, в методах с `NoInlining` и в методах, слишком больших для встраивания.

Обёртка вокруг целого числа или ссылки на этих ABI такой проблемы не имеет. `readonly record struct UserId(int Value)` передаётся в `ECX` на Windows x64, в `EDI` на System V и в `W0` на ARM64, точно так же, как простой `int`. Структура, оборачивающая ссылку на объект, передаётся как указатель. Расхождение специфично для полей с плавающей точкой (и, как показано ниже, для структур с несколькими полями), потому что только у значений с плавающей точкой есть отдельный файл регистров, который ABI может решить пропустить.

## Настоящая ошибка: типы-обёртки в сигнатурах P/Invoke

Разница в производительности - сноска. Разница в корректности - нет. Если вы используете строго типизированную обёртку в сигнатуре `LibraryImport` или `DllImport`, у которой нативный аналог принимает базовый примитив, вы утверждаете, что обёртка прозрачна. Маршалер этого не проверяет, потому что структура blittable и передаётся как есть.

Вот воспроизведение на библиотеке `abi.c` выше:

```csharp
// .NET 11 RC1, C# 15
using System.Runtime.InteropServices;

Console.WriteLine($"{RuntimeInformation.ProcessArchitecture} / {RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"take_double(Meters 21)  = {Native.TakeDoubleAsMeters(new Meters(21)).Value}");
Console.WriteLine($"take_two_floats(Vec2)   = {Native.TakeTwoFloatsAsVec2(new Vec2(1f, 2f))}");
Console.WriteLine($"take_two_floats(f, f)   = {Native.TakeTwoFloats(1f, 2f)}");

public readonly record struct Meters(double Value);
public readonly record struct Vec2(float X, float Y);

static partial class Native
{
    // Wrong on purpose: the C side is double take_double(double)
    [LibraryImport("libabi", EntryPoint = "take_double")]
    public static partial Meters TakeDoubleAsMeters(Meters m);

    // Wrong on purpose: the C side is float take_two_floats(float, float)
    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloatsAsVec2(Vec2 v);

    [LibraryImport("libabi", EntryPoint = "take_two_floats")]
    public static partial float TakeTwoFloats(float x, float y);
}
```

В macOS arm64:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 3
take_two_floats(f, f)   = 3
```

Всё "работает". `Meters` - это HFA из одного `double`, `Vec2` - HFA из двух `float`, и AAPCS64 помещает их в `D0` и `S0`/`S1`, ровно туда, куда смотрит нативный код.

В macOS x64 (System V), тот же бинарный файл, та же библиотека:

```text
take_double(Meters 21)  = 42
take_two_floats(Vec2)   = 1
take_two_floats(f, f)   = 3
```

`Meters` по-прежнему работает, потому что единственный eightbyte класса SSE передаётся в `XMM0`. `Vec2` не работает: System V упаковывает оба `float` в один eightbyte, поэтому вся структура приходит в младшие 64 бита `XMM0`. Нативная функция читает `x` из `XMM0`, а `y` из `XMM1`, где лежит то, что осталось от прежних операций. В этом запуске там оказался ноль, поэтому ответ был `1`. В другом запуске там может быть что угодно.

В Windows x64 ломаются оба неверных объявления. `Meters` передаётся в `RCX`, в то время как `take_double` читает `XMM0`, а результат читается из `RAX`, в то время как нативный код записал его в `XMM0`. `Vec2` (8 байт) тоже передаётся в `RCX`. Нативную сторону можно подтвердить по листингу `x86_64-pc-windows-msvc` выше; управляемая сторона подчиняется тому же правилу, которое показывает дизассемблированный код `ScaleMeters`.

Это классическая ошибка "на моём Mac работает, на Windows-агенте сборки получается мусор". Код, проверенный и протестированный на ноутбуках с ARM64, проходит, а первый запуск на Windows x64 выдаёт бессмыслицу или значение, которое слегка отличается от верного.

## Как писать типы-обёртки, безопасные на любой границе

В .NET 11 нет атрибута, который делал бы структуру прозрачной. `[StructLayout(LayoutKind.Sequential)]`, `Pack` и `Size` управляют раскладкой в памяти, а не классификацией по регистрам. Поэтому решение состоит в том, чтобы держать обёртки по управляемую сторону границы.

1. **Объявляйте нативные сигнатуры с точными нативными типами.** Если C принимает `double`, P/Invoke принимает `double`. Оборачивайте и разворачивайте в тонком управляемом методе:

    ```csharp
    // .NET 11 RC1, C# 15
    static partial class Native
    {
        [LibraryImport("libabi", EntryPoint = "take_double")]
        private static partial double TakeDouble(double d);

        public static Meters Scale(Meters m) => new(TakeDouble(m.Value));
    }
    ```

    Метод-обёртка встраивается, так что за типобезопасность вы ничего не платите.

2. **Используйте структуру в P/Invoke только тогда, когда нативная сторона использует структуру с теми же полями.** Если в заголовке C написано `Vec2 v`, то `Vec2` в C# с теми же полями в том же порядке корректна на любом ABI, потому что обе стороны применяют одну и ту же классификацию. Ошибка возникает только тогда, когда с одной стороны структура, а с другой россыпь скаляров.

3. **Так же относитесь к указателям на функции и `UnmanagedCallersOnly`.** У `delegate* unmanaged<Meters, Meters>` та же проблема, что и у `LibraryImport`, как и у экспорта `[UnmanagedCallersOnly]`, который нативный хост вызывает с `double`. Если вы создаёте так аддоны Node или хосты плагинов, как в [написании аддонов Node.js на .NET Native AOT](/ru/2026/04/nodejs-addons-dotnet-native-aot/), оставляйте экспортируемые сигнатуры примитивными.

4. **Для горячих управляемых путей на Windows x64 сначала проверьте, встраивается ли вызов.** Если профилировщик указывает на метод без встраивания, который принимает или возвращает обёртку с плавающей точкой, посмотрите на дизассемблированный код. [Просмотрщик ASM в Rider для дизассемблирования JIT и Native AOT](/ru/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) или `DOTNET_JitDisasm` покажут пару `vmovq`. После этого можно передавать примитив через горячую границу или перестроить код так, чтобы вызов встраивался.

## Подводные камни и граничные случаи

- **Два `float` - это не один `double`.** Многие считают, что "8 байт есть 8 байт". `Vec2(float, float)` занимает 8 байт, но это один eightbyte класса SSE в System V, HFA из двух элементов на ARM64 и целочисленный блок на Windows x64. Три ABI, три ответа. Именно этот случай чаще всего подводит кроссплатформенный игровой и графический код.
- **Смешанные поля снова меняют классификацию.** `struct { int Id; float Weight; }` занимает 8 байт. В System V это один eightbyte класса INTEGER (целое побеждает, когда в eightbyte смешаны классы), и он передаётся в `RDI`. На ARM64 это не HFA, поэтому он передаётся в `X0`. На Windows x64 - в `RCX`. Ни один из вариантов не совпадает с раздельной передачей `int` и `float`.
- **Размер важен на Windows x64.** По значению в регистре передаются только структуры размером 1, 2, 4 и 8 байт. Структура в 12 или 16 байт передаётся по ссылке на копию, выделенную вызывающей стороной, и это куда более существенное отличие от раздельной передачи её полей. В System V и ARM64 структуры до 16 байт по-прежнему передаются в регистрах.
- **Методы экземпляра в классах C++ - это снова другое.** MSVC возвращает пользовательские типы из нестатических функций-членов через скрытый указатель, даже когда они поместились бы в `RAX`. Поэтому существует `CallConvMemberFunction` в `System.Runtime.CompilerServices`, и поэтому методы COM, возвращающие небольшие структуры, - известная ловушка.
- **Продвижение структуры скрывает цену, но не убирает её.** Внутри метода JIT заменяет продвинутую структуру её полем, поэтому локальная арифметика над `Meters` так же быстра, как над `double`. Продвижение не меняет то, как значение пересекает вызов. Если вы выбираете между структурами и классами для объектов-значений, [матрица решений record, class и struct](/ru/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) рассматривает сторону размера и копирования в этом компромиссе.
- **ReadyToRun и Native AOT используют те же правила.** Предкомпилированный код всё равно должен соответствовать ABI платформы, поэтому публикация с [Native AOT или ReadyToRun](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) не делает обёртку прозрачной. Вывод crossgen2 в этой статье - это код ReadyToRun.

## Появится ли в .NET настоящая transparent-раскладка?

Не в .NET 11. Ближайшее, что есть в дорожной карте, - это [предложение о раскладке структур для взаимодействия в dotnet/runtime#100896](https://github.com/dotnet/runtime/issues/100896), в рамках которого одобрен `CustomLayoutAttribute` с видами раскладки для структур в стиле C, объединений и типов Swift. В обсуждении прямо упоминаются запросы на механизм вроде `repr(transparent)` в Rust, но одобренная форма его не включает, а в июле 2026 года задачу перенесли с этапа 11.0.0 на 12.0.0. Если transparent-вид когда-нибудь появится, он позволит JIT и маршалеру классифицировать обёртку с одним полем как само это поле на любом ABI, и именно это делает [RFC 1758 в Rust](https://rust-lang.github.io/rfcs/1758-repr-transparent.html) для своих newtype.

Пока что правило короткое: обёртки бесплатны в памяти и бесплатны после встраивания, но на границе ABI они являются агрегатами, и только платформа решает, имеет ли это значение. Не используйте их в нативных сигнатурах, а если вам всё же нужно передать их через горячий вызов без встраивания на Windows x64, сначала прочитайте дизассемблированный код.

## Связанные материалы

- [Record, class и struct в C#: матрица решений](/ru/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) - о том, как вообще выбирать форму типа-значения.
- [Просмотрщик ASM в Rider 2026.1 для дизассемблирования JIT и Native AOT](/ru/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) - самый простой способ увидеть пару `vmovq` самостоятельно.
- [Native AOT, ReadyToRun и JIT в .NET 11](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) - чем различаются три режима генерации кода и где они не различаются.
- [Polars.NET и LibraryImport](/ru/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/) - реальная библиотека на Rust, которой необходимо правильно описывать эти сигнатуры.
- [Аддоны Node.js на .NET Native AOT](/ru/2026/04/nodejs-addons-dotnet-native-aot/), где экспорты `UnmanagedCallersOnly` подчиняются тому же правилу в обратную сторону.

## Источники

- [x64 calling convention](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention), документация Microsoft C++, правила Windows x64 для агрегатов и возвращаемых значений.
- [System V AMD64 ABI](https://gitlab.com/x86-psABIs/x86-64-ABI), раздел 3.2.3, о классификации eightbyte.
- [Procedure Call Standard for the Arm 64-bit Architecture (AAPCS64)](https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst), о правиле HFA.
- [dotnet/runtime#100896: New attribute for interop-specific struct concerns](https://github.com/dotnet/runtime/issues/100896).
- [dotnet/runtime#43867: Keep structs in registers](https://github.com/dotnet/runtime/issues/43867), задача отслеживания JIT по обработке структур с одним полем.
- [Rust RFC 1758: repr(transparent)](https://rust-lang.github.io/rfcs/1758-repr-transparent.html).
