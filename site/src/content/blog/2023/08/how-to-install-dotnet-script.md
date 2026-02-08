---
title: "How to install dotnet script"
description: "dotnet script enables you to run C# scripts (.CSX) from the .NET CLI. The only requirement is to have .NET 6 or newer installed on your machine. You can use the following command to install dotnet-script globally: Then to execute a script file you simply call dotnet script <file_path> like in the example below: How…"
pubDate: 2023-08-29
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
  - "net"
---
`dotnet script` enables you to run C# scripts (`.CSX`) from the .NET CLI. The only requirement is to have .NET 6 or newer installed on your machine.

You can use the following command to install dotnet-script globally:

```bash
dotnet tool install -g dotnet-script
```

Then to execute a script file you simply call `dotnet script <file_path>` like in the example below:

```bash
dotnet script startdebugging.csx
```

## How to initialize a new dotnet script

If you are just getting started and you want to create a new dotnet script file you can use the `init` command to scaffold a script project.

```bash
dotnet script init startdebugging.csx
```

This will create your script file along with the launch configuration needed to debug the script using VS Code. Note that the file name is optional and will default to `main.csx` if you don’t specify it.

```plaintext
. 
├── .vscode 
│   └── launch.json 
├── startdebugging.csx 
└── omnisharp.json
```

## Implicit usings

dotnet script comes with some namespaces included by default, similar to the implicit usings feature you’re used with in .NET SDK projects. Below you have the full list of namespaces implicitly available in dotnet-script.

```cs
System
System.IO
System.Collections.Generic
System.Console
System.Diagnostics
System.Dynamic
System.Linq
System.Linq.Expressions
System.Text
System.Threading.Tasks
```
