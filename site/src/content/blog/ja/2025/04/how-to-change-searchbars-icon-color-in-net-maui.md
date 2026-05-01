---
title: ".NET MAUI で SearchBar のアイコン色を変更する方法"
description: ".NET 10 で導入された新しい SearchIconColor プロパティを使って、.NET MAUI の SearchBar のアイコン色を変更する方法。"
pubDate: 2025-04-10
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2025/04/how-to-change-searchbars-icon-color-in-net-maui"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 10 から、MAUI のサーチバーには `SearchBar` の検索アイコンの色を変更するための新しいプロパティ `SearchIconColor` が追加されました。

[![](/wp-content/uploads/2025/04/image.png)](/wp-content/uploads/2025/04/image.png)

他のバインド可能なプロパティと同様に、`Purple` のような色の値を割り当てたり、次のようにリソースにバインドしたりできます。

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
