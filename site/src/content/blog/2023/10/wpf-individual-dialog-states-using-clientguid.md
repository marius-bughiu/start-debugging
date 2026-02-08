---
title: "WPF – Individual dialog states using ClientGuid"
description: "A new ClientGuid property, introduced with .NET 8, allows you to uniquely identify dialogs such as the OpenFileDialog and the OpenFolderDialog, with the purpose of storing state – such as window size, position and last used folder – separately per dialog. To benefit from this behavior, configure the ClientGuid of your dialog to a known…"
pubDate: 2023-10-13
updatedDate: 2023-11-05
tags:
  - "net"
  - "net-8"
  - "wpf"
---
A new `ClientGuid` property, introduced with .NET 8, allows you to uniquely identify dialogs such as the `OpenFileDialog` and the `OpenFolderDialog`, with the purpose of storing state – such as window size, position and last used folder – separately per dialog.

To benefit from this behavior, configure the `ClientGuid` of your dialog to a known identifier before calling the `ShowDialog()` method.

```cs
static readonly Guid _id = new Guid("32bc5a4c-e28f-408a-8aca-e0b430fbc17c");

var dialog = new OpenFileDialog 
{
    ClientGuid = _id
};

dialog.ShowDialog();
```

The dialog state is persisted across different runs of the application and even across different apps, all that matters is that the `ClientGuid` is the same.

**Note:** Make sure you use the same identifier across different application instances. Do not generate the `Guid` at runtime using `Guid.NewGuid()` since that will result in a new `Guid` every time you run the application, and your dialog state will reset. Instead, store the `Guid` as in the example above, or create a `KnownDialogs` class specifically for the purpose of storing dialog identifiers.
