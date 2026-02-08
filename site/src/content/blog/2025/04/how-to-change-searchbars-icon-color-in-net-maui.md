---
title: "How to change SearchBar’s icon color in .NET MAUI"
description: "Starting with .NET 10, MAUI’s search bar comes with a new property for changing the SearchBar‘s search icon color: SearchIconColor. As with any dependency property, you can assign it a color value like Purple or bind it to a resource as follows:"
pubDate: 2025-04-10
tags:
  - "maui"
  - "net"
  - "net-10"
---
Starting with .NET 10, MAUI’s search bar comes with a new property for changing the `SearchBar`‘s search icon color: `SearchIconColor`.

[![](/wp-content/uploads/2025/04/image.png)](/wp-content/uploads/2025/04/image.png)

As with any dependency property, you can assign it a color value like `Purple` or bind it to a resource as follows:

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
