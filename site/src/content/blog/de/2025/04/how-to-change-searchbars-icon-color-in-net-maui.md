---
title: "Wie Sie die Symbolfarbe der SearchBar in .NET MAUI ändern"
description: "Wie Sie die Symbolfarbe der SearchBar in .NET MAUI mit der neuen Eigenschaft SearchIconColor aus .NET 10 ändern."
pubDate: 2025-04-10
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2025/04/how-to-change-searchbars-icon-color-in-net-maui"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 10 bietet die Suchleiste von MAUI eine neue Eigenschaft, mit der Sie die Farbe des Suchsymbols der `SearchBar` ändern können: `SearchIconColor`.

[![](/wp-content/uploads/2025/04/image.png)](/wp-content/uploads/2025/04/image.png)

Wie bei jeder bindbaren Eigenschaft können Sie ihr einen Farbwert wie `Purple` zuweisen oder sie an eine Ressource binden, wie folgt:

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
