---
title: "3D Animations Using Pure CSS3"
description: "What determined me to write this post and a few others was this page (works in Chrome and Safari only). Amazing what you can do by using only CSS. So, let’s take a look under the hood – the css for that effect looks like this: Kind of messy. But if we strip out the…"
pubDate: 2012-03-04
updatedDate: 2023-11-05
tags:
  - "css"
---
What determined me to write this post and a few others was [this page](http://demo.marcofolio.net/3d_animation_css3/ "CSS3 3D Animations") (works in Chrome and Safari only). Amazing what you can do by using only CSS. So, let’s take a look under the hood – the css for that effect looks like this:

```css
#movieposters li { 
    display:inline; float:left;
    -webkit-perspective: 500; -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective; -webkit-transition-duration: 0.5s; 
}

#movieposters li:hover { 
    -webkit-perspective: 5000; 
}

#movieposters li img { 
    border:10px solid #fcfafa; 
    -webkit-transform: rotateY(30deg);
    -moz-box-shadow:0 3px 10px #888; 
    -webkit-box-shadow:0 3px 10px #888;
    -webkit-transition-property: transform; 
    -webkit-transition-duration: 0.5s; 
}

#movieposters li:hover img { 
    -webkit-transform: rotateY(0deg); 
}
```

Kind of messy. But if we strip out the borders and shadows and arrange the code a bit, you’ll see it’s actually not that complicated.

```css
#movieposters li {
    display:inline; float:left;
    -webkit-perspective: 500;
    -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective;
    -webkit-transition-duration: 0.5s;
}

#movieposters li:hover {
    -webkit-perspective: 5000;
}

#movieposters li img {
    -webkit-transform: rotateY(30deg);
    -webkit-transition-property: transform;
    -webkit-transition-duration: 0.5s;
}

#movieposters li:hover img {
    -webkit-transform: rotateY(0deg);
}
```

As you can see what’s being done are basically two transitions:

-   a perspective transition on the list item from a value of 500 to a value of 5000 on hover with a duration of 0.5s
-   and a rotate transform transition on the image inside the list item, with the same duration, from 30 degrees to 0 degrees

You can play with the values and see what other nice effects you can obtain. Maybe even leave a comment with a link to the nice effect that you’ve obtained.

## Making it work in Firefox

Now what really intrigued me was the fact that it didn´t work in Firefox. Why? After doing a couple of searches on Google the answer became obvious, -webkit- commands are for webkit-based browsers while Firefox requires commands prefixed with -moz-. I guess I should’ve known that already…

So I’ve added new lines for each command and replaced the -webkit- with -moz- thinking that it will work. It did, except for the fact that it had no animation. Couple of searches later and still no answer, so in the true spirit of a developer I typed in stackoverflow.com and asked my question. A couple of hours later I had my first answer and fortunately it held the solution to my problem ([check it out here if you want](http://stackoverflow.com/questions/9549624/moz-transition-duration-not-working "Firefox Transitions not working")). The transition-property had to be a -moz- property as well. Simple properties like transform or perspective don’t work like they do in webkit so I had to use -moz-transform and -moz-perspective instead.

So here’s the complete CSS code that I’ve ended using:

```css
#movieposters li {
    display:inline; float:left;
    -webkit-perspective: 500;
    -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective;
    -webkit-transition-duration: 0.5s;
    -moz-transition-duration: 0.5s;
    -moz-perspective: 500;
    -moz-transform-style: preserve-3d;
    -moz-transition-property: -moz-perspective;
}

#movieposters li:hover {
    -webkit-perspective: 5000;
    -moz-perspective: 5000;
}

#movieposters li img {
    -webkit-transform: rotateY(30deg);
    -webkit-transition-property: transform;
    -webkit-transition-duration: 0.5s;
    -moz-transition-duration: 0.5s;
    -moz-transform: rotateY(30deg);
    -moz-transition-property: -moz-transform;
    width: 210px;
}

#movieposters li:hover img {
    -webkit-transform: rotateY(0deg);
    -moz-transform: rotateY(0deg);
}
```

Also, you can check out a demo here: [3D CSS Animation](http://startdebugging.net/demos/3dcssanimation.html "3D CSS Animation")
