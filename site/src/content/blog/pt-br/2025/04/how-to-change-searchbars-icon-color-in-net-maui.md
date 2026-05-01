---
title: "Como alterar a cor do ícone do SearchBar no .NET MAUI"
description: "Como alterar a cor do ícone do SearchBar no .NET MAUI usando a nova propriedade SearchIconColor introduzida no .NET 10."
pubDate: 2025-04-10
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2025/04/how-to-change-searchbars-icon-color-in-net-maui"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 10, a search bar do MAUI traz uma nova propriedade para alterar a cor do ícone de busca do `SearchBar`: `SearchIconColor`.

[![](/wp-content/uploads/2025/04/image.png)](/wp-content/uploads/2025/04/image.png)

Como em qualquer propriedade vinculável, você pode atribuir a ela um valor de cor como `Purple` ou vinculá-la a um recurso da seguinte forma:

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
