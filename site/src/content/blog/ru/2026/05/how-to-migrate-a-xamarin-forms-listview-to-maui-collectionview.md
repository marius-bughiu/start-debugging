---
title: "Миграция высокопроизводительного Xamarin.Forms ListView на MAUI CollectionView"
description: "Пошаговая миграция с Xamarin.Forms 5.0 ListView на .NET MAUI 11 CollectionView для приложений, в которых уже выжимали максимум производительности из ListView. Рассмотрены переиспользование ячеек, виртуализация, группировка, pull-to-refresh, контекстные действия, выделение, ItemsLayout, EmptyView и подводные камни, которые встречаются в реальных приложениях."
pubDate: 2026-05-07
updatedDate: 2026-05-07
template: migration
tags:
  - "maui"
  - "xamarin"
  - "xamarin-forms"
  - "collectionview"
  - "listview"
  - "migration"
  - "dotnet"
lang: "ru"
translationOf: "2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview"
translatedBy: "claude"
translationDate: 2026-05-07
---

Кратко: замените `ListView` на `CollectionView`, обёрнутый в `RefreshView`, если вам нужен был pull-to-refresh, замените `ContextActions` на `SwipeView`, удалите `HasUnevenRows`, `RowHeight` и `CachingStrategy`, поскольку виртуализация с переиспользованием ячеек теперь единственный режим в MAUI, и перепишите выделение с `ItemTapped` / `ItemSelected` на `SelectionMode` плюс `SelectionChangedCommand`. Если ваш старый `ListView` был настроен с `CachingStrategy="RecycleElement"`, `HasUnevenRows="True"` и `DataTemplateSelector`, переход в основном механический. Протестировано на .NET MAUI 11.0 GA в `net11.0-android35.0`, `net11.0-ios18.0` и `net11.0-maccatalyst18.0`. Рассчитывайте на один-три дня сосредоточенной работы для приложения с пятью-десятью списками, дольше, если вы активно используете группировку в стиле `TableView` или собственные рендеры `ViewCell`.

Поддержка Xamarin.Forms закончилась [1 мая 2024 года](https://dotnet.microsoft.com/en-us/platform/support/policy/maui), а MAUI 11 GA вышел в ноябре 2025 года с третьим поколением исправлений CollectionView, устраняющих дёрганья на Android. Если вы откладывали миграцию, потому что производительность вашего приложения была вручную настроена под особенности `ListView`, такие как `RecycleElementAndDataTemplate`, обновляться стоит сейчас: CollectionView в MAUI 11 наконец сравнялся со старым `ListView` из Xamarin.Forms на Android или превзошёл его, если выключить `ItemSizingStrategy.MeasureAllItems`. Это руководство для такой аудитории.

## Зачем мигрировать сейчас

- Xamarin.Forms не поддерживается. Никаких CVE-патчей, никаких исправлений для Android 15 / iOS 18. Магазины приложений продолжат требовать повышения целевого SDK; следовать за ними на Xamarin.Forms невозможно.
- CollectionView это единственный контрол коллекций в MAUI, использующий нативные виртуализирующие коллекции платформы (`RecyclerView` на Android, `UICollectionView` на iOS). `ListView` существует в MAUI для обратной совместимости, но это [тонкая обёртка, которая под капотом делегирует работу CollectionView](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview), и наследует форму устаревшего API, а не устаревший рендерер.
- `ItemsLayout` позволяет переключаться между линейным и сеточным макетами без наследования или хаков с repeater. Один контрол покрывает то, для чего раньше требовались `ListView` плюс `FlowListView`.
- `EmptyView` это полноценное шаблонное свойство, а не ручное переключение `IsVisible` на соседней метке.

## Что ломается

| Область | Xamarin.Forms ListView | MAUI CollectionView | Серьёзность |
| ---- | ---------------------- | ------------------- | -------- |
| Стратегия кеширования | `CachingStrategy="RetainElement"` или `RecycleElement` | Всегда переиспользует. Свойство отсутствует. | средняя |
| Высота строки | `HasUnevenRows`, `RowHeight` | `ItemSizingStrategy="MeasureAllItems"` или `MeasureFirstItem` | средняя |
| Pull to refresh | `IsPullToRefreshEnabled`, `RefreshCommand` на `ListView` | Оборачивайте в `RefreshView` | высокая |
| Тип ячейки | `ViewCell`, `TextCell`, `ImageCell` | Обычный `DataTemplate` с любым корнем макета | высокая |
| Обработка нажатий | `ItemTapped`, `ItemSelected` | `SelectionMode`, `SelectionChanged`, `SelectionChangedCommand` | высокая |
| Свайп-действия | `ContextActions` | `SwipeView` | высокая |
| Разделители | `SeparatorVisibility`, `SeparatorColor` | Нет. Добавьте `BoxView` в шаблон. | низкая |
| Заголовки / нижние колонтитулы | `Header`, `Footer` (объект или шаблон) | Те же имена, но только как шаблоны / представления | низкая |
| Группировка | `IsGroupingEnabled`, `GroupHeaderTemplate` | `IsGrouped`, `GroupHeaderTemplate`, `GroupFooterTemplate` | средняя |
| Прокрутка к элементу | `ScrollTo(item, ScrollToPosition)` | `ScrollTo(item, position, animate)` | низкая |
| Пустое состояние | Ручная соседняя метка | `EmptyView`, `EmptyViewTemplate` | низкая |

Два изменения, которые причиняют боль, это pull-to-refresh и выделение. Всё остальное это просто переименование или удаление.

## Предполётный чеклист

1. Установлен .NET 11 SDK (`dotnet --version` сообщает `11.0.x`). MAUI 11 требует .NET 11 SDK. В более ранних SDK нет манифеста workload.
2. Установлен MAUI workload: `dotnet workload install maui`. Если вы обновлялись поверх более старой установки, сначала выполните `dotnet workload repair`.
3. Доступны платформы Android SDK 35, iOS 18 и Mac Catalyst 18. Visual Studio 2022 17.13 или Visual Studio Code с расширением .NET MAUI 1.6+.
4. Ветка `git`, которую можно выбросить. Держите проект на Xamarin.Forms собирающимся в `main`, пока сборка MAUI не станет зелёной на реальном устройстве.
5. Список каждого экземпляра `ListView` в проекте. Сгруппируйте их по функциональным областям; мигрируйте по одной функции и выпускайте за feature flag, если ваш цикл релизов ежемесячный.
6. Запустите [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) на проекте один раз, чтобы он обработал изменения `csproj`, пространств имён и `MauiProgram`. Upgrade Assistant не переписывает XAML с `ListView` за вас, чем и занимается остальная часть этого поста.

## Шаги миграции

### 1. Замените `ListView` на `CollectionView`

Простейший случай это плоский список с собственным `DataTemplate`:

```xml
<!-- Before. Xamarin.Forms 5.0 -->
<ListView ItemsSource="{Binding Articles}"
          CachingStrategy="RecycleElementAndDataTemplate"
          HasUnevenRows="True"
          SeparatorVisibility="None"
          ItemTapped="OnArticleTapped">
    <ListView.ItemTemplate>
        <DataTemplate>
            <ViewCell>
                <Grid Padding="12" RowDefinitions="Auto,Auto">
                    <Label Text="{Binding Title}" FontAttributes="Bold" />
                    <Label Grid.Row="1" Text="{Binding Excerpt}" />
                </Grid>
            </ViewCell>
        </DataTemplate>
    </ListView.ItemTemplate>
</ListView>
```

```xml
<!-- After. .NET MAUI 11.0 -->
<CollectionView ItemsSource="{Binding Articles}"
                SelectionMode="Single"
                SelectionChangedCommand="{Binding OpenArticleCommand}"
                SelectionChangedCommandParameter="{Binding Source={RelativeSource Self}, Path=SelectedItem}">
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:ArticleVm">
            <Grid Padding="12" RowDefinitions="Auto,Auto">
                <Label Text="{Binding Title}" FontAttributes="Bold" />
                <Label Grid.Row="1" Text="{Binding Excerpt}" />
            </Grid>
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

Что изменилось:

- `ViewCell` исчез. Корнем шаблона теперь напрямую является макет (`Grid`, `VerticalStackLayout` и т. п.).
- `CachingStrategy` исчез. Переиспользование всегда включено. Старый `RecycleElementAndDataTemplate` это ближайший аналог, и теперь это единственный режим.
- `HasUnevenRows="True"` исчез. CollectionView по умолчанию измеряет каждую ячейку. Если все ваши строки одного размера, установите `ItemSizingStrategy="MeasureFirstItem"` для измеримого выигрыша в производительности прокрутки на Android.
- `SeparatorVisibility="None"` это новое поведение по умолчанию. Добавьте `BoxView HeightRequest="1"` внутрь шаблона, если разделитель действительно нужен.
- `x:DataType` на шаблоне включает компилируемые привязки. Указывайте всегда. Производительность CollectionView резко падает с привязками через рефлексию на Android.

**Проверка**: соберите для Android (`dotnet build -t:Run -f net11.0-android35.0`) и прокрутите список из 1000 элементов на устройстве среднего класса. Время кадра должно быть меньше 16 мс в режиме Profile GPU Rendering в Android Studio. Если нет, проверьте, что `x:DataType` указан и что ни одна привязка внутри шаблона не использует `Source={x:Reference ...}`.

### 2. Оборачивание в `RefreshView` для pull-to-refresh

`IsPullToRefreshEnabled`, `IsRefreshing` и `RefreshCommand` больше не находятся на списке. Они живут в `RefreshView`, который оборачивает любое прокручиваемое содержимое.

```xml
<!-- After. .NET MAUI 11.0 -->
<RefreshView IsRefreshing="{Binding IsRefreshing}"
             Command="{Binding RefreshCommand}">
    <CollectionView ItemsSource="{Binding Articles}"
                    SelectionMode="Single">
        <CollectionView.ItemTemplate>
            <DataTemplate x:DataType="vm:ArticleVm">
                <!-- as before -->
            </DataTemplate>
        </CollectionView.ItemTemplate>
    </CollectionView>
</RefreshView>
```

`RefreshView` срабатывает только тогда, когда обёрнутый прокручиваемый контрол находится на нулевом смещении, поэтому поведение совпадает со старым `ListView`. Никакого `IsPullToRefreshEnabled` нет; если нужно отключить, установите `IsEnabled="False"` на `RefreshView`.

**Проверка**: потяните вниз по списку, находясь на нулевом смещении. Должен появиться платформенный спиннер, а `RefreshCommand` должен срабатывать ровно один раз за жест.

### 3. Перепишите выделение

Событие `ItemTapped` в Xamarin.Forms срабатывает на каждое нажатие, даже если `SelectedItem` не изменился. CollectionView чётко разделяет это: нажатие это выделение, а выделение наблюдается через `SelectionChanged` или `SelectionChangedCommand`. Если вы полагались на нажатие для перехода к одному и тому же элементу два раза подряд, придётся отказываться от состояния выделения, читая и очищая `SelectedItem` после каждого перехода:

```csharp
// MainViewModel.cs, .NET MAUI 11.0, C# 14
[RelayCommand]
private async Task OpenArticleAsync(ArticleVm? selected)
{
    if (selected is null) return;
    await Shell.Current.GoToAsync(nameof(ArticleDetailPage),
        new Dictionary<string, object> { ["article"] = selected });
    SelectedArticle = null; // re-arm so the same row can fire next time
}
```

`SelectionMode="None"` плюс `TapGestureRecognizer` внутри шаблона это ближайший эквивалент старой семантики `ItemTapped`. Используйте его только при наличии причины. Шаблон на основе выделения это то, что ожидают платформы, и именно он бесплатно даёт вам кольца фокуса доступности на Windows.

**Проверка**: нажмите на элемент, вернитесь назад, нажмите на тот же элемент. Оба нажатия должны открывать страницу деталей.

### 4. Замените `ContextActions` на `SwipeView`

```xml
<!-- Before. Xamarin.Forms 5.0 -->
<ViewCell>
    <ViewCell.ContextActions>
        <MenuItem Text="Delete" IsDestructive="True"
                  Command="{Binding DeleteCommand}" />
    </ViewCell.ContextActions>
    <Grid>...</Grid>
</ViewCell>
```

```xml
<!-- After. .NET MAUI 11.0 -->
<SwipeView>
    <SwipeView.RightItems>
        <SwipeItems Mode="Execute">
            <SwipeItem Text="Delete"
                       BackgroundColor="Crimson"
                       Command="{Binding DeleteCommand}" />
        </SwipeItems>
    </SwipeView.RightItems>
    <Grid>...</Grid>
</SwipeView>
```

`SwipeView` это полноценный свайп влево и вправо с настраиваемыми фонами. `IsDestructive` превращается в обычный `BackgroundColor`. `Mode="Execute"` соответствует старому поведению с закрытием по нажатию; `Mode="Reveal"` оставляет меню открытым. Длительное нажатие на iOS для показа меню исчезло; если оно нужно, используйте `MenuFlyout` в MAUI 11 (новинка этого релиза).

**Проверка**: свайпните влево на iOS и Android. Нажмите delete. Элемент удаляется. Свайпните по следующей строке, чтобы убедиться, что одновременно открыт только один свайп.

### 5. Переключите группировку

```xml
<!-- After. .NET MAUI 11.0 -->
<CollectionView ItemsSource="{Binding ArticlesByDay}"
                IsGrouped="True">
    <CollectionView.GroupHeaderTemplate>
        <DataTemplate x:DataType="vm:ArticleDayVm">
            <Label Text="{Binding Day, StringFormat='{0:D}'}"
                   FontAttributes="Bold"
                   Padding="12,8" />
        </DataTemplate>
    </CollectionView.GroupHeaderTemplate>
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:ArticleVm">
            <!-- as before -->
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

Меняются две вещи. Флаг называется `IsGrouped`, а не `IsGroupingEnabled`. И источник должен быть коллекцией коллекций, где каждый внешний элемент сам является перечислимым. Самый чистый шаблон это класс `Grouping<TKey, TItem>`, наследуемый от `List<TItem>` и предоставляющий `Key`. Это тот же шаблон, который использовал Xamarin.Forms, и он переносится без изменений.

**Проверка**: прокрутите сгруппированный список из 30 дней. Заголовки групп должны прилипать к верху своей группы на iOS по умолчанию (`GroupHeadersStick="True"` на нативном iOS; поведение MAUI по умолчанию повторяет это).

### 6. Выберите `ItemsLayout`

По умолчанию используется вертикальный `LinearItemsLayout`, что соответствует `ListView`. Переключение на сетку с одной линией:

```xml
<CollectionView ItemsSource="{Binding Photos}">
    <CollectionView.ItemsLayout>
        <GridItemsLayout Orientation="Vertical"
                         Span="3"
                         HorizontalItemSpacing="4"
                         VerticalItemSpacing="4" />
    </CollectionView.ItemsLayout>
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:PhotoVm">
            <Image Source="{Binding ThumbnailUrl}" Aspect="AspectFill" />
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

`Span="3"` это фиксированное число столбцов. Встроенной адаптивной сетки нет; для неё размеры ячеек подгоняются под доступную ширину через behavior или повторное связывание при изменениях размера.

**Проверка**: поверните устройство. Сетка должна перерисоваться без потери позиции прокрутки.

### 7. Добавьте `EmptyView`

```xml
<CollectionView ItemsSource="{Binding Articles}">
    <CollectionView.EmptyView>
        <VerticalStackLayout HorizontalOptions="Center"
                             VerticalOptions="Center" Spacing="8">
            <Label Text="No articles yet" FontSize="18" />
            <Button Text="Refresh" Command="{Binding RefreshCommand}" />
        </VerticalStackLayout>
    </CollectionView.EmptyView>
</CollectionView>
```

Для нескольких пустых состояний (нет данных против ошибки) привяжите `EmptyView` к свойству и используйте `EmptyViewTemplate` с `DataTemplateSelector`.

**Проверка**: очистите источник. Появляется пустое представление. Заполните источник снова. Пустое представление исчезает без кадра наложения.

## Чеклист проверки

После миграции каждого списка:

- `dotnet build -c Release` для `net11.0-android35.0`, `net11.0-ios18.0`, `net11.0-maccatalyst18.0` и `net11.0-windows10.0.19041.0` выдаёт ноль предупреждений об устаревших API `ListView`.
- `dotnet test` против слоя ViewModel зелёный. Логика выделения это наиболее вероятная регрессия; покройте её тестами.
- На Android прокрутите список из 1000 элементов на Pixel 6 или эквиваленте. Время кадра остаётся меньше 16 мс с `MeasureFirstItem`, если строки одинаковые. С `MeasureAllItems` и 1000 элементов ожидайте единоразовых затрат на измерение при первом отображении.
- На iOS удерживайте палец на строке. После отпускания не должно оставаться обратной связи о выделении, если `SelectionMode="None"`.
- Pull-to-refresh срабатывает ровно один раз за жест на каждой платформе.
- Свайп-действия открываются с правильной стороны (RTL-языки автоматически зеркалируются; проверьте на арабской локали, если вы её поставляете).
- `EmptyView` объявляется через VoiceOver / TalkBack. CollectionView автоматически добавляет текст доступности для пустого состояния; ручное `SemanticProperties.Description` его переопределяет.

## План отката

На практике это односторонняя миграция. Как только проект переведён на целевые фреймворки `net11.0-*` и `MauiProgram.cs`, возврат к Xamarin.Forms означает восстановление старой формы `csproj`, `Xamarin.Forms.Forms.Init` и платформенных точек входа приложения. Ничто из описанного в этом посте про CollectionView само по себе не обратимо отдельно от обновления проекта. Планируйте отгрузить рабочую сборку MAUI до удаления ветки Xamarin.Forms.

## Подводные камни, на которые мы наткнулись

- Семантика `ItemTapped`. Если ваш старый код вызывал `ListView.SelectedItem = null` в `ItemTapped`, чтобы по той же строке можно было нажать дважды, вам нужно продолжать очищать `SelectedItem` (или `SelectedItems`) после каждого перехода. CollectionView не очищает автоматически.
- `RemainingItemsThreshold` для бесконечной прокрутки находится на CollectionView (`RemainingItemsThreshold` плюс `RemainingItemsThresholdReachedCommand`). Старый шаблон с `ItemAppearing` всё ещё работает, но срабатывает на каждый элемент; шаблон с порогом срабатывает один раз ближе к низу, что и нужно большинству UI с бесконечной прокруткой.
- `ScrollTo` больше не принимает значение `MakeVisible` перечисления `ScrollToPosition`. Ближайшее соответствие это `ScrollToPosition.MakeVisible` к `ScrollToPosition.MakeVisible` (то же имя, то же перечисление), но второй аргумент теперь индекс группы. Для несгруппированного списка передавайте `null`. Прочитайте [документацию по ScrollTo для CollectionView](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/scrolling) перед переносом любой собственной логики прокрутки.
- Компилируемые привязки (`x:DataType`) обязательны для производительности. Без них прокрутка дёргается на Android, потому что каждая привязка разрешается через рефлексию на каждом переиспользовании.
- `ItemSizingStrategy.MeasureAllItems` на длинном списке с переменной высотой принудительно вызывает один полный проход измерения при первом отображении. Если у вас десять тысяч элементов и список это первое, что появляется на экране, время до первого кадра ухудшается. По возможности используйте фиксированную высоту ячейки.
- Собственные рендеры `ViewCell` не переносятся. В MAUI нет `ViewCellRenderer`. Если у вас был такой, ячейка становится обычным макетом в MAUI, а логика рендерера переходит на [handler](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) того дочернего контрола, которому она была нужна.
- `TableView` всё ещё существует в MAUI для статических экранов в стиле настроек. Не используйте его для динамических данных. Он не виртуализирует.

## Связанное

- [Как корректно поддерживать тёмную тему в приложении MAUI](/ru/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) описывает шаблоны `AppThemeBinding`, которые нужны шаблонам внутри CollectionView.
- [Как реализовать drag-and-drop в MAUI 11](/ru/2026/05/how-to-implement-drag-and-drop-in-maui-11/) показывает, как комбинировать `DragGestureRecognizer` с элементами `CollectionView`, что является современной заменой переупорядочивания в ListView.
- [Как упаковать приложение MAUI для Microsoft Store](/ru/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) это следующий шаг после миграции, когда вы хотите снова отгружать на Windows.
- [Как написать приложение MAUI, которое работает только на Windows и macOS](/ru/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) это правильный ориентир, если вы одновременно отказываетесь от мобильных платформ в проекте на Xamarin.Forms.

## Источники

- [Документация .NET MAUI CollectionView](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/)
- [Документация .NET MAUI ListView](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview)
- [Политика поддержки Xamarin.Forms](https://dotnet.microsoft.com/en-us/platform/support/policy/maui)
- [Обновление с Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) на MS Learn
- [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)
