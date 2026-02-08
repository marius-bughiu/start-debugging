---
title: "How to pass arguments to a dotnet script"
description: "When using dotnet script you can pass arguments by specifying them after — (two dashes). You can the access the arguments in the script using the Args collection. Let’s take an example. Assume we have the following myScript.csx script file: We can pass parameter to this script as follows:"
pubDate: 2023-06-12
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
---
When using **dotnet script** you can pass arguments by specifying them after **—** (two dashes). You can the access the arguments in the script using the **Args** collection.  
  
Let’s take an example. Assume we have the following **myScript.csx** script file:

```cs
Console.WriteLine($"Inputs: {string.Join(", ", Args)}");
```

We can pass parameter to this script as follows:

```cs
dotnet script myScript.csx -- "a" "b"
```
