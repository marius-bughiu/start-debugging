---
title: "dotnet new api -aot: ‘-aot’ is not a valid option"
description: "Fix the '-aot is not a valid option' error by using the correct double-hyphen syntax: dotnet new api --aot."
pubDate: 2023-06-14
updatedDate: 2023-11-05
tags:
  - "dotnet"
---
The correct syntax for generating a project with AOT is `--aot` (with 2 hyphens). In this particular case, the correct command would be:

```bash
dotnet new api --aot
```
