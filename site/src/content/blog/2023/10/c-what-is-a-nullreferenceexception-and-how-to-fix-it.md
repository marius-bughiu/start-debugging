---
title: "C# – What is a NullReferenceException, and how to fix it?"
description: "Learn what causes a NullReferenceException in C#, how to debug it, and how to prevent it using null checks, the null-conditional operator, and nullable reference types."
pubDate: 2023-10-20
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
A `NullReferenceException` is a common runtime error which occurs when your code tries to access or manipulate an object or a member of an object, but the object reference is currently set to `null` (meaning it doesn’t reference any valid object in memory). In other words, you’re trying to perform an operation on something that doesn’t exist.

Here’s a very simple example:

```cs
string myString = null;
int length = myString.Length;
```

In this example, we have a string variable `myString` that is assigned a `null` value. When we try to access its `Length` property, a `NullReferenceException` is thrown because you can’t get the length of a string that doesn’t exist.

## How to debug?

Your primary focus should be on identifying the source of the null reference. The debugger allows you to precisely pinpoint the location of the problem.

First, take a close look at the exception details provided by the debugger, which will specify the exact line of code where the exception occurred. This line is crucial in identifying the variable or object responsible for the null reference.

Next, inspect the variables and objects by hovering over them or using the `Locals` and `Watch` windows of your editor. These tools allow you to examine the state of your application at the point of the exception. Pay particular attention to variables that are used or accessed on the line that triggered the exception. If any of these variables are null when they shouldn’t be, you’ve likely identified the source of the problem.

Additionally, examine the call stack in the Call Stack window to trace back through the method calls leading up to the exception. This can help you understand the context in which the null reference occurred, aiding in the identification of the root cause. Once you’ve identified the variable or object responsible for the null reference, you can then proceed to fix the issue by checking for null values and implementing appropriate null checks to prevent future exceptions.

## How to prevent?

To prevent `NullReferenceException`s, it’s crucial to check for `null` values before attempting to access properties or methods of objects. You can use conditional statements like `if` to check for `null` before accessing an object’s members. For example:

```cs
string myString = null; 

if (myString != null) 
{ 
    int length = myString.Length; // This will only execute if 'myString' is not null. 
}
```

Or you can use the null-conditional operator (introduced in C# 6.0) to safely access members of objects that might be null:

```cs
string myString = null; 
int? length = myString?.Length; // 'length' will be null if 'myString' is null.
```

### Nullable reference types

Another way to avoid `NullReferenceException`s is by enabling nullable reference types, a feature introduced in C# 8.0. It helps developers write safer and more reliable code by providing a way to express whether a reference type (e.g., classes and interfaces) can be null or non-null. This feature helps catch potential null reference exceptions at compile time and improves code readability and maintainability.

When you enable nullable reference types in your code, the compiler will generate warnings for potential null reference issues. You need to add annotations to make your intentions clear, which helps in reducing or eliminating these warnings.

Nullable reference types use annotations to indicate whether a reference type can be `null`:

-   `T?`: Indicates that a reference type `T` can be `null`.
-   `T`: Indicates that a reference type `T` is non-nullable.
