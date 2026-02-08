---
title: "Improve productivity by using code snippets"
description: "Learn how code snippets in Visual Studio can improve your productivity by letting you insert reusable pieces of code with a short alias."
pubDate: 2012-01-06
updatedDate: 2023-11-04
tags:
  - "c-sharp"
  - "visual-studio"
---
Code snippets are a great way of improving your productivity because they allow you to define pieces of code which you can later on insert into your projects by using a short alias.

Although they’ve been in Visual Studio for quite some time not many people know what they are, what exactly they do and how to use them to their advantage. Hearing about them is one thing, using them is another thing. Almost every one of us (those who write code) used them at least once in our lives and the best example I can think of while saying this is: foreach. I mean, how many times have you typed in foreach and then pressed TAB twice for some code to magically appear at your cursor’s location? Yea, that’s a code snippet! And there is a lot more from where that came from. There are code snippets for things like class definition, constructors, destructors, structures, for, do-while, etc. and a complete list (for C#) can be found here: [Visual C# Default Code Snippets](http://msdn.microsoft.com/en-US/library/z41h7fat%28v=VS.100%29.aspx "Visual C# Default Code Snippets").

But those are just a small part of what code snippets can offer, those are the default code snippets that come with Visual Studio. The really nice thing about code snippets is that you can define your own and then use them to insert code in your projects wherever and whenever you want.  I will try and create a simple tutorial on how to create your own code snippet sometime next week, until then you [can check out this page](http://msdn.microsoft.com/en-us/library/ms165393.aspx "can check out this page").

For those of you looking for a couple of general snippets to add to the already existing one, there’s [a nice project on codeplex](http://vssnippets.codeplex.com/ "C# Code Snippets") which contains exactly 38 C# code snippets ready to be added to your collection. Adding them to your Visual Studio is easy: just download the zip file from the link mentioned above and extract the file. Then go to Tools -> Code Snippet Manager or press Ctrl + K, Ctrl + B and click on Import. Browse to the folder where you’ve extracted the zip file, select all the code snippets inside the folder and hit Open, then select which folder / category to add them in (My Code Snippets by default) and click finish. And voila! they are ready to be used. To try them out and see if they really work you can try for example typing task or thread somewhere and hitting TAB twice – your code should be automatically inserted.

So, that’s it for now. As I’ve promised, how to create your own code snippets and maybe also something about some snippet designers coming up next week.
