---
title: "WPF – Prevent file dialog selection from being added to recents"
description: "Prevent WPF file dialog selections from appearing in Windows Explorer recents and the Start Menu by setting AddToRecent to false in .NET 8."
pubDate: 2023-10-18
updatedDate: 2023-11-05
tags:
  - "net"
  - "net-8"
  - "wpf"
---
Files opened or saved using WPF’s file dialogs (`OpenFileDialog`, `SaveFileDialog` or `OpenFolderDialog`) are by default added to the Windows Explorer’s recent files list and can also impact the Recommended section of the Start Menu in Windows 11.

To disable this behavior, you can set `AddToRecent` to `false` on your dialog before calling the `ShowDialog()` method. Note: this property was added as part of .NET 8, so in case you don’t have it available, make sure your project is targeting .NET 8 or newer.

And for a very quick example:

```cs
var dialog = new OpenFileDialog 
{
    AddToRecent = false
};
 
dialog.ShowDialog();
```

That’s it. Now the files picked by the user using the `OpenFileDialog` will no longer show in the recent files list or in the start menu.

Note: `AddToRecent` has a default value of `true`. So unless you explicitly set it to `false`, the files picked using the dialogs will show up in the recents.
