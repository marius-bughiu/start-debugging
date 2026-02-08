---
title: "Is there a C# With…End With statement equivalent?"
description: "The With…End With statement in VB allows you to execute a series of statements that repeatedly refer to a single object. Thus the statements can use a simplified syntax for accessing members of the object. For example: Is there a C# syntax equivalent? No. There is not. The closest thing to it would be the…"
pubDate: 2023-08-05
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
The With…End With statement in VB allows you to execute a series of statements that repeatedly refer to a single object. Thus the statements can use a simplified syntax for accessing members of the object. For example:

```vb
With car
    .Make = "Mazda"
    .Model = "MX5"
    .Year = 1989
End With
```

## Is there a C# syntax equivalent?

No. There is not. The closest thing to it would be the object initializers, but those are only for instantiating new objects, they cannot be used to update existing object instances, like the with statement can.

As an example, when creating a new object instance, you can use the object initializer:

```cs
var car = new Car
{
    Make = "Mazda",
    Model = "MX5",
    Year = 1989
};
```

But when updating the object, there is no equivalent simplified syntax. You would have to reference the object for each assignment or member call, like so:

```cs
car.Make = "Aston Martin";
car.Model = "DBS";
car.Year = 1967;
```
