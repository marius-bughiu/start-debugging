---
title: "Как изменить цвет иконки SearchBar в .NET MAUI"
description: "Как изменить цвет иконки SearchBar в .NET MAUI с помощью нового свойства SearchIconColor, появившегося в .NET 10."
pubDate: 2025-04-10
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2025/04/how-to-change-searchbars-icon-color-in-net-maui"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 10, у строки поиска MAUI появилось новое свойство для изменения цвета иконки поиска у `SearchBar`: `SearchIconColor`.

[![](/wp-content/uploads/2025/04/image.png)](/wp-content/uploads/2025/04/image.png)

Как и любому bindable-свойству, ему можно присвоить значение цвета, например `Purple`, или привязать его к ресурсу следующим образом:

```xml
<Grid>
    <Grid.RowDefinitions>
        <RowDefinition Height="Auto" />
        <RowDefinition Height="*" />
    </Grid.RowDefinitions>
    <SearchBar Placeholder="Search videos..." SearchIconColor="{StaticResource Primary}" />
    <ScrollView>
        <VerticalStackLayout>
            
        </VerticalStackLayout>
    </ScrollView>
</Grid>
```
