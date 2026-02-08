---
title: "Get Embedded Resource Stream in .NET Core"
description: "In order to retrieve an embedded resource in .NET Core, we first need to understand how the resource name is composed. It’s got 3 elements, all joined by dots (.): Let’s take a concrete example. We have a project (assembly) with a root namespace MyApp.Core. Inside our project we’ve got a folder + subfolder like…"
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
In order to retrieve an embedded resource in .NET Core, we first need to understand how the resource name is composed. It’s got 3 elements, all joined by dots (`.`):

-   the root namespace
-   the extended or file namespace
-   the file name

Let’s take a concrete example. We have a project (assembly) with a root namespace `MyApp.Core`. Inside our project we’ve got a folder + subfolder like `Assets` > `Images`. And inside of that, we have an embeded resource called `logo.png`. In this case:

-   the root namespace: `MyApp.Core`
-   the entended namespace: `Assets.Images`
-   the file name `logo.png`

Join them using `.` and you get: `MyApp.Core.Assets.Images.logo.png`.

Once you know the resource identifier, all you need is a reference to the assembly containing the actual resource. We can easily obtain that off of any class we have defined in that assembly – assuming we have a class `MyClass`:

```cs
typeof(MyClass).Assembly.GetManifestResourceStream("MyApp.Core.Assets.Images.logo.png")
```

## Retrieve list with all embedded resources in an assembly

If you can’t find the resource, it’s usually because of one of the following:

-   you’ve got the identifier wrong
-   you haven’t marked the file as an Embeded Resource
-   you are looking in the wrong assembly

To help troubleshoot, you can list all the embeded resources in an assembly and go from there. To do so:

```cs
typeof(MyClass).Assembly.GetManifestResourceNames()
```

This will return a simple `string[]` and you can easily use it in the `Immediate Window` for debugging purposes.
