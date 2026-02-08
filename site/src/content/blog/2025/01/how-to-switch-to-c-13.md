---
title: "How to switch to C# 13"
description: "While trying out C# 13 features, it’s possible you might come across errors similar to these: Feature is not available in C# 12.0. Please use language version 13.0 or later. or Error CS8652: The feature ‘<feature name>’ is currently in Preview and unsupported. To use Preview features, use the ‘preview’ language version. There are two…"
pubDate: 2025-01-01
updatedDate: 2025-01-02
tags:
  - "c-13"
  - "c-sharp"
  - "net"
  - "net-9"
---
While trying out C# 13 features, it’s possible you might come across errors similar to these:

> Feature is not available in C# 12.0. Please use language version 13.0 or later.

or

> Error CS8652: The feature ‘<feature name>’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

There are two ways to solve this error:

-   change the target framework of your project to .NET 9 or higher. The language version should be updated automatically.
-   edit your **.csproj** file and specify the desired **<LangVersion>** like in the example below:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## Language version is greyed out and cannot be modified

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

The Language version cannot be changed from the **Properties** window of the project. The version is linked to the target .NET framework version of your project and will be updated accordingly depending on that.

If you must override the language version, you have to do it as specified above, by modifying the **.csproj** file and specifying the **LangVersion**.

Remember that each C# language version has a minimum supportet .NET version. C# 13 is supported only on .NET 9 and newer versions. C# 12 is supported only on .NET 8 and newer versions.

## C# LangVersion options

Besides the version numbers, there are certain keywords that can be used to specify the language version of your project:

-   **preview** – refers to the latest preview version
-   **latest** – the latest released version (including minor version)
-   **latestMajor** or **default** – the latest released major version

#### Not what you’re looking for?

You might be looking to switch to a different version of C#, in that case:

-   [How to switch to C# 12](/2023/06/how-to-switch-to-c-12/)
-   [How to switch to C# 11](/2023/03/how-to-switch-to-c-11/)
