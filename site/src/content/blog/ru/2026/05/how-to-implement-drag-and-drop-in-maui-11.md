---
title: "Как реализовать drag-and-drop в .NET MAUI 11"
description: "Полный drag-and-drop в .NET MAUI 11: DragGestureRecognizer, DropGestureRecognizer, пользовательские полезные нагрузки DataPackage, AcceptedOperation, позиция жеста и платформенные ловушки PlatformArgs на Android, iOS, Mac Catalyst и Windows."
pubDate: 2026-05-03
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "drag-and-drop"
  - "gestures"
  - "how-to"
lang: "ru"
translationOf: "2026/05/how-to-implement-drag-and-drop-in-maui-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

Короткий ответ: в .NET MAUI 11 присоедините `DragGestureRecognizer` к исходному `View` и `DropGestureRecognizer` к целевому `View` через их коллекцию `GestureRecognizers`. Для текста и изображений во встроенных элементах управления (`Label`, `Entry`, `Image`, `Button` и им подобных) фреймворк сам подключает `DataPackage`, поэтому брошенное значение приходит автоматически. Для всего остального заполняйте `e.Data` в обработчике `DragStarting` и читайте из `e.Data` (это `DataPackageView`) в обработчике `Drop`. Установите `e.AcceptedOperation = DataPackageOperation.Copy` или `None` в `DragOver`, чтобы управлять курсором, и спускайтесь в `e.PlatformArgs`, когда вам нужен пользовательский предпросмотр перетаскивания, операция Move или чтение файлов, брошенных из другого приложения.

Этот пост проходит по всей поверхности API с исполняемыми XAML и C# для .NET MAUI 11.0.0 на .NET 11, включая части, которые официальная документация замалчивает: как `DataPackagePropertySet` на самом деле перемещает управляемые объекты, почему ваша операция Move молча понижается до Copy на Android, почему ваша пользовательская фигура `null` при втором перетаскивании и как прочитать путь к файлу, когда drop приходит из Проводника или Photos. Всё ниже было проверено на `dotnet new maui` из .NET 11 SDK с `Microsoft.Maui.Controls` 11.0.0.

## Почему drag-and-drop в MAUI интереснее, чем кажется

Два распознавателя жестов, `DragGestureRecognizer` и `DropGestureRecognizer`, унаследованы от Xamarin.Forms 5 и присутствуют в коробке с самого первого релиза MAUI. Форма API не изменилась в MAUI 11, но платформенно-специфичная история значительно улучшилась: свойства `PlatformArgs`, появившиеся в MAUI 9, теперь стабильны на всех четырёх поддерживаемых головах, что означает, что вы наконец можете делать такие вещи, как пользовательский предпросмотр перетаскивания на iOS, drop нескольких файлов из Проводника Windows и `UIDropOperation.Move` на Mac Catalyst, не опускаясь до пользовательского handler.

Что стоит усвоить, прежде чем писать любой код: распознаватели жестов это абстракция MAUI над четырьмя очень разными нативными системами. Android использует `View.startDragAndDrop` с `ClipData`, iOS и Mac Catalyst используют `UIDragInteraction` и `NSItemProvider`, Windows использует WinRT-инфраструктуру `DragDrop` на `FrameworkElement`. Кроссплатформенный `DataPackage` несёт текст, изображение и мешок свойств `Dictionary<string, object>`. Всё, что вы кладёте в этот мешок свойств, **локально для процесса**, потому что нижележащие нативные системы могут маршалить через границы приложений только текст, изображения и URI файлов. Это самый большой источник сюрпризов, когда разработчики переходят с внутриприложенческого drag на межприложенческий.

Если вы пришли из Xamarin.Forms, ни один из ваших существующих обработчиков менять не нужно. Имена классов, сигнатуры событий и перечисление `DataPackageOperation` побайтно идентичны. История `PlatformArgs` новая; всё остальное это тот же код, что был выпущен в 2020 году.

## Перетаскивание текстового Label на Entry

Начните с самого маленького полезного случая: перетащить текстовое значение из `Label` и бросить его на `Entry`. Поскольку оба это встроенные текстовые элементы управления, MAUI заполняет `DataPackage` и читает его обратно автоматически, так что вся функциональность находится в XAML.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<VerticalStackLayout Padding="20" Spacing="20">
    <Label Text="Drag this label"
           FontSize="20">
        <Label.GestureRecognizers>
            <DragGestureRecognizer />
        </Label.GestureRecognizers>
    </Label>

    <Entry Placeholder="Drop here">
        <Entry.GestureRecognizers>
            <DropGestureRecognizer />
        </Entry.GestureRecognizers>
    </Entry>
</VerticalStackLayout>
```

Жест перетаскивания инициируется long-press с последующим перетаскиванием на сенсорных платформах и обычным mouse-down-and-move на Windows и Mac Catalyst. Никакого code-behind не требуется: MAUI читает `Label.Text` в `DataPackage.Text` на выходе и пишет `DataPackage.Text` в `Entry.Text` на входе.

Та же автоматическая разводка покрывает `CheckBox.IsChecked`, `DatePicker.Date`, `Editor.Text`, `RadioButton.IsChecked`, `Switch.IsToggled` и `TimePicker.Time` как со стороны источника, так и со стороны назначения, плюс изображения на `Button`, `Image` и `ImageButton`. Булевы значения и даты конвертируются через round-trip по `string`, что означает, что некорректный drop (перетаскивание текста "yes" на `CheckBox`) молча не переключит `IsChecked`.

## Перемещение карточки между двумя колонками

Интересный случай это ваш собственный UI: доска с карточками, которые вы хотите перетаскивать между колонками. `DataPackage` не может переносить управляемый объект между процессами, но для внутриприложенческого drag он совершенно точно может перенести его через `Properties`.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Grid ColumnDefinitions="*,*" Padding="20" ColumnSpacing="20">
    <VerticalStackLayout x:Name="TodoColumn" Grid.Column="0" Spacing="8">
        <VerticalStackLayout.GestureRecognizers>
            <DropGestureRecognizer DragOver="OnDragOver" Drop="OnDrop" />
        </VerticalStackLayout.GestureRecognizers>
        <Label Text="To do" FontAttributes="Bold" />
    </VerticalStackLayout>

    <VerticalStackLayout x:Name="DoneColumn" Grid.Column="1" Spacing="8">
        <VerticalStackLayout.GestureRecognizers>
            <DropGestureRecognizer DragOver="OnDragOver" Drop="OnDrop" />
        </VerticalStackLayout.GestureRecognizers>
        <Label Text="Done" FontAttributes="Bold" />
    </VerticalStackLayout>
</Grid>
```

Каждая карточка строится в коде и получает собственный `DragGestureRecognizer`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public record Card(Guid Id, string Title);

Border BuildCardView(Card card)
{
    var border = new Border
    {
        Padding = 12,
        StrokeThickness = 1,
        BindingContext = card,
        Content = new Label { Text = card.Title }
    };

    var drag = new DragGestureRecognizer();
    drag.DragStarting += (s, e) =>
    {
        e.Data.Properties["Card"] = card;
        e.Data.Text = card.Title; // fallback for inter-app drops
    };
    border.GestureRecognizers.Add(drag);

    return border;
}
```

Событие `DragStarting` получает `DragStartingEventArgs`, чьё свойство `Data` это новый `DataPackage` для каждого перетаскивания. Установка `e.Data.Properties["Card"]` сохраняет фактическую ссылку на `Card` в `Dictionary<string, object>`. Со стороны drop вы обращаетесь к тому же словарю:

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragOver(object sender, DragEventArgs e)
{
    e.AcceptedOperation = e.Data.Properties.ContainsKey("Card")
        ? DataPackageOperation.Copy
        : DataPackageOperation.None;
}

void OnDrop(object sender, DropEventArgs e)
{
    if (e.Data.Properties.TryGetValue("Card", out var value) && value is Card card)
    {
        var targetColumn = (VerticalStackLayout)sender;
        MoveCard(card, targetColumn);
        e.Handled = true;
    }
}
```

Здесь происходят две неочевидные вещи.

Во-первых, `e.Data` на `DropEventArgs` это `DataPackageView`, а не `DataPackage`. Он намеренно только для чтения: цель drop не может изменять пакет. Вы читаете `Properties` (это `DataPackagePropertySetView`) и вызываете `await e.Data.GetTextAsync()` или `await e.Data.GetImageAsync()` для зарезервированных слотов текста и изображения. Асинхронные методы возвращают `Task<string?>` и `Task<ImageSource?>` соответственно.

Во-вторых, установка `e.Handled = true` в обработчике `Drop` говорит MAUI не применять поведение по умолчанию. Это важно, когда ваша цель drop это `Label` или `Image`, потому что иначе MAUI *также* попытается установить текст или изображение из data package поверх того, что вы сделали вручную, что приводит к багу двойного обновления, который мучительно отлаживать.

## Выбор правильного `AcceptedOperation`

Событие `DragOver` срабатывает непрерывно, пока указатель находится над целью drop. Его задача установить `e.AcceptedOperation`, что определяет визуальное представление курсора на Windows и Mac Catalyst и системную обратную связь на iOS. Перечисление `DataPackageOperation` имеет ровно два значения, поставляемых с MAUI: `Copy` и `None`. Нет `Move`, нет `Link`, нет комбинаций флагов, независимо от того, что предлагает IntelliSense, если вы подключили `Windows.ApplicationModel.DataTransfer`.

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragOver(object sender, DragEventArgs e)
{
    var canAccept = e.Data.Properties.ContainsKey("Card");
    e.AcceptedOperation = canAccept
        ? DataPackageOperation.Copy
        : DataPackageOperation.None;
}
```

Когда `DragEventArgs` конструируется, `AcceptedOperation` по умолчанию равно `Copy`. Если вы хотите колонку, отвергающую все drops (например, доступную только для чтения колонку "Архив" в режиме просмотра), вы должны активно установить её в `None` в `DragOver`. Забыть это это самая частая причина, по которой цель случайно принимает всё подряд.

Чтобы получить семантику Move на iOS и Mac Catalyst, где система действительно различает Copy и Move с видимым значком, спуститесь в `PlatformArgs`:

```csharp
// .NET MAUI 11.0.0, .NET 11, iOS / Mac Catalyst
void OnDragOver(object sender, DragEventArgs e)
{
#if IOS || MACCATALYST
    e.PlatformArgs?.SetDropProposal(
        new UIKit.UIDropProposal(UIKit.UIDropOperation.Move));
#endif
}
```

На Android drag-and-drop не различает Copy и Move на межприложенческом уровне, поэтому свойство `AcceptedOperation` управляет только внутриприложенческой подсказкой. На Windows курсор `Copy` против `None` управляется напрямую из `AcceptedOperation`.

## Настройка предпросмотра перетаскивания

Стандартный предпросмотр перетаскивания это снимок исходного view, что обычно нормально. Когда нет, каждая платформа предоставляет собственный хук предпросмотра через `PlatformArgs`.

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragStarting(object sender, DragStartingEventArgs e)
{
#if IOS || MACCATALYST
    e.PlatformArgs?.SetPreviewProvider(() =>
    {
        var image = UIKit.UIImage.FromFile("dotnet_bot.png");
        var imageView = new UIKit.UIImageView(image)
        {
            Frame = new CoreGraphics.CGRect(0, 0, 200, 200),
            ContentMode = UIKit.UIViewContentMode.ScaleAspectFit
        };
        return new UIKit.UIDragPreview(imageView);
    });
#elif ANDROID
    var view = (Android.Views.View)((Microsoft.Maui.Controls.View)sender).Handler!.PlatformView!;
    e.PlatformArgs?.SetDragShadowBuilder(new Android.Views.View.DragShadowBuilder(view));
#endif
}
```

На Android `SetDragShadowBuilder` управляет тенью, следующей за пальцем; на iOS и Mac Catalyst `SetPreviewProvider` возвращает `UIDragPreview`; на Windows установите свойства `e.PlatformArgs.DragStartingEventArgs.DragUI` и не забудьте установить `e.PlatformArgs.Handled = true`, чтобы MAUI не перезаписал ваши изменения.

Этот флаг `Handled` это самая лёгкая ловушка во всём API: на Windows каждый `PlatformArgs` это тонкая обёртка над объектом event args WinRT, и любое свойство, которое вы устанавливаете, молча перезаписывается стандартной разводкой MAUI, если только вы не установите `Handled = true` на самих platform args (отдельно от `DragEventArgs.Handled` и `DropEventArgs.Handled`, которые управляют обработкой на уровне MAUI).

## Получение позиции drop

В MAUI 11 все три event args (`DragStartingEventArgs`, `DragEventArgs` и `DropEventArgs`) предоставляют метод `GetPosition(Element?)`, возвращающий `Point?`. Передайте `null` для экранных координат или передайте элемент, чтобы получить координаты относительно этого элемента.

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDrop(object sender, DropEventArgs e)
{
    var canvas = (Layout)sender;
    var point = e.GetPosition(canvas);
    if (point is { } p)
    {
        AbsoluteLayout.SetLayoutBounds(_draggedView!,
            new Rect(p.X, p.Y, AbsoluteLayout.AutoSize, AbsoluteLayout.AutoSize));
    }
}
```

Если вы помните старый workaround чтения `MotionEvent.GetX/Y` из Android-овского `PlatformArgs.DragEvent` и `LocationInView` из iOS-овского `DropSession`, он вам больше не нужен. `GetPosition` возвращает `null` только тогда, когда платформа действительно не сообщила позицию (редко, но обращайтесь с nullable как с критичным).

## Получение файла из другого приложения

Межприложенческое перетаскивание поддерживается на iOS, Mac Catalyst и Windows. Android не может быть целью drop для элементов из другого приложения через API распознавателя жестов.

Форма данных платформенно-специфична, потому что межпроцессная полезная нагрузка всегда нативна: коллекция `UIDragItem` на iOS и Mac Catalyst, `DataPackageView` на Windows. MAUI даёт вам нативные объекты через `PlatformArgs`.

```csharp
// .NET MAUI 11.0.0, .NET 11, Windows
async void OnDrop(object sender, DropEventArgs e)
{
#if WINDOWS
    var view = e.PlatformArgs?.DragEventArgs.DataView;
    if (view is null || !view.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems))
        return;

    var items = await view.GetStorageItemsAsync();
    foreach (var item in items)
    {
        if (item is Windows.Storage.StorageFile file)
            HandleDroppedFile(file.Path);
    }
#endif
}
```

Вариант для iOS/Mac Catalyst использует `e.PlatformArgs.DropSession.Items` и просит каждый `NSItemProvider` загрузить in-place file representation. Полный паттерн из примеров .NET MAUI задокументирован на Microsoft Learn по адресу [Drag and drop between applications](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0#drag-and-drop-between-applications).

Для обеих платформ обработчик `Drop` выполняется в UI-потоке, и файл ещё не скопирован. Если вам нужны байты, скопируйте их внутри обработчика перед возвратом, потому что приложению-источнику разрешено отозвать сессию перетаскивания, как только ваш обработчик завершится.

## Пять ловушек, которые съедят полдня

**1. `DataPackage` одноразовый.** Каждый жест перетаскивания создаёт новый `DataPackage`. Если вы кешируете `e.Data` и пытаетесь прочитать его позже из другого drop, вы получите данные из *исходного* перетаскивания, а не из текущего, что является источником багов "вторая карточка, которую я перетаскиваю, неправильная".

**2. `Properties` локально для процесса.** Всё, что вы кладёте в `e.Data.Properties`, безупречно работает внутри вашего приложения и невидимо между приложениями. Если вы хотите полезную нагрузку, переживающую межприложенческий drop, дополнительно установите `e.Data.Text` (или запишите в `PlatformArgs.SetClipData` на Android, `SetItemProvider` на iOS), чтобы у системы было что-то конкретное для маршалинга.

**3. Стандартный drop на `Label`/`Image`/`Entry` всегда срабатывает.** Если вы обрабатываете `Drop` и обновляете цель вручную, установите `e.Handled = true`, иначе автоматическое присваивание текста или изображения MAUI выполнится после вашего обработчика и затрёт результат.

**4. `DropGestureRecognizer` не всплывает.** Каждый визуальный элемент либо имеет распознаватель, либо нет. Если вы поставите распознаватель на родительский `Grid`, а у дочернего `Border` нет собственного распознавателя, жест работает как ожидается; но если у ребёнка есть какой-либо другой распознаватель жестов, hit-testing для drop может попасть на ребёнка и пропустить родителя. Будьте явны: ставьте распознаватель drop на самый глубокий элемент, который должен принимать drop.

**5. Drag-and-drop на Android требует `View`, участвующий в hit testing.** `Label` с `InputTransparent="True"` молча откажется начинать перетаскивание, а `BoxView` без цвета фона будет перехватывать жесты только над прямоугольником, который растеризатор реально рисует. Если ваше перетаскивание никогда не начинается на Android, установите `BackgroundColor` на исходный view как проверку на здравомыслие, прежде чем тянуться к переопределениям `Handler`.

## Строительные блоки для более богатых взаимодействий

Drag-and-drop это путь с наименьшим трением, чтобы добавить прямую манипуляцию в десктопное или планшетное MAUI-приложение, но распознаватели жестов это также блок, к которому вы тянетесь, когда пишете переупорядочиваемый список, окно tab-tear-out или доску в стиле Trello. Ничего из этого сегодня не складывается в один контрол библиотеки, поэтому каждое серьёзное MAUI-приложение для десктопа катит своё. Хорошая новость в том, что нижележащий API достаточно мал, чтобы "катить своё" обычно означало сотню строк кода, большая часть которой это платформенно-специфичная настройка предпросмотра, а не сама обработка жестов.

Если вы строите только десктопную голову MAUI, остальная часть [настройки MAUI 11 только для Windows и macOS](/ru/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) проходит через стрипание мобильных target frameworks, чтобы ваш `dotnet build` перестал тащить workloads Android и iOS. Для обзора того, что ещё нового в фреймворке, смотрите [что нового в .NET MAUI 10](/ru/2025/04/whats-new-in-net-maui-10/), который покрывает дополнения `PlatformArgs`, от которых зависит этот пост. Если вам нужно переопределить цвета темы, появляющиеся в вашем предпросмотре перетаскивания, тот же паттерн handler в [как изменить цвет иконки SearchBar в .NET MAUI](/ru/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) обобщается на большинство нативных настроек предпросмотра. И если ваше приложение это библиотека классов, размещающая эти жесты, [как зарегистрировать handlers в библиотеке MAUI](/ru/2023/11/maui-library-register-handlers/) покрывает разводку `MauiAppBuilder`, которая нужна, чтобы распознаватели действительно прикреплялись при запуске потребляющего приложения.

## Источники

- [Recognize a drag and drop gesture - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0)
- [DragGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.draggesturerecognizer)
- [DropGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.dropgesturerecognizer)
- [DataPackage Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.datapackage)
- [.NET MAUI Drag and Drop Gesture sample](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/gestures-draganddropgesture/)
