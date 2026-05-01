---
title: "Cómo cambiar el color del icono del SearchBar en .NET MAUI"
description: "Cómo cambiar el color del icono del SearchBar en .NET MAUI usando la nueva propiedad SearchIconColor introducida en .NET 10."
pubDate: 2025-04-10
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2025/04/how-to-change-searchbars-icon-color-in-net-maui"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 10, la barra de búsqueda de MAUI incluye una nueva propiedad para cambiar el color del icono de búsqueda del `SearchBar`: `SearchIconColor`.

[![](/wp-content/uploads/2025/04/image.png)](/wp-content/uploads/2025/04/image.png)

Como con cualquier propiedad enlazable, puedes asignarle un valor de color como `Purple` o enlazarla a un recurso de la siguiente manera:

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
