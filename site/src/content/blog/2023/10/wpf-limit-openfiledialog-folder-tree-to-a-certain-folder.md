---
title: "WPF – Limit OpenFileDialog folder tree to a certain folder"
description: "Learn how to constrain the WPF OpenFileDialog folder tree to a specific root folder using the RootDirectory property in .NET 8."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
---
Starting with .NET 8, you can constrain the `OpenFileDialog` and `OpenFolderDialog` folder tree to a given root folder. You can do so by setting the `RootDirectory` property on the dialog before calling `ShowDialog()`.

It’s very important to note that this does not limit the selection and the navbar navigation in any way. The user will still be able to navigate to folders outside the specified `RootDirectory`. The same goes for the `InitialDirectory` property which you can set to any folder you’d like outside the `RootDirectory`.

Let’s look at an example:

```cs
var dialog = new OpenFileDialog
{
    InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
    RootDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
};

dialog.ShowDialog();
```

This will show an open file dialog focused on the `MyDocuments` folder, while its folder tree on the left will be scoped to the specified root directory – in this case, `MyPictures`.

[![OpenFileDialog with a constrained folder tree using RootDirectory.](/wp-content/uploads/2023/10/image.png)](/wp-content/uploads/2023/10/image.png)
