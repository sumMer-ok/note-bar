package com.notebar.app.domain

import java.time.LocalDate

/** 每日一句。对应 iOS `DailyQuote` */
data class DailyQuote(
    val english: String,
    val chinese: String,
    val author: String,
)

/**
 * 每日一句词库。逐字移植自 `NoteBarApp/Models/DailyQuote.swift`：
 * 24 条原文 + 「按一年中的第几天确定性取一条」（同一天固定、次日轮换）。
 */
object DailyQuoteBook {

    val quotes: List<DailyQuote> = listOf(
        DailyQuote("The only way to do great work is to love what you do.", "成就伟业的唯一途径，就是热爱你所做的事。", "Steve Jobs"),
        DailyQuote("Stay hungry, stay foolish.", "求知若饥，虚心若愚。", "Steve Jobs"),
        DailyQuote("It always seems impossible until it's done.", "事情在完成之前，总是看起来不可能。", "Nelson Mandela"),
        DailyQuote("Education is the most powerful weapon which you can use to change the world.", "教育是你可以用来改变世界的最有力的武器。", "Nelson Mandela"),
        DailyQuote("The best time to plant a tree was 20 years ago. The second best time is now.", "种一棵树最好的时间是二十年前，其次是现在。", "Chinese Proverb"),
        DailyQuote("Success is not final, failure is not fatal: it is the courage to continue that counts.", "成功不是终点，失败也并非末日，重要的是继续前进的勇气。", "Winston Churchill"),
        DailyQuote("You miss 100% of the shots you don't take.", "你不挥杆，就百分之百打不中。", "Wayne Gretzky"),
        DailyQuote("Whether you think you can or you think you can't, you're right.", "无论你认为自己能或不能，你都是对的。", "Henry Ford"),
        DailyQuote("The journey of a thousand miles begins with a single step.", "千里之行，始于足下。", "Lao Tzu"),
        DailyQuote("Genius is one percent inspiration and ninety-nine percent perspiration.", "天才是百分之一的灵感加上百分之九十九的汗水。", "Thomas Edison"),
        DailyQuote("In the middle of difficulty lies opportunity.", "困难之中孕育着机遇。", "Albert Einstein"),
        DailyQuote("Life is what happens when you're busy making other plans.", "生活就是当你忙于制定其他计划时，正在发生的一切。", "John Lennon"),
        DailyQuote("The secret of getting ahead is getting started.", "领先的秘诀就是开始行动。", "Mark Twain"),
        DailyQuote("Do what you can, with what you have, where you are.", "就地取材，尽力而为。", "Theodore Roosevelt"),
        DailyQuote("Well done is better than well said.", "说得好不如做得好。", "Benjamin Franklin"),
        DailyQuote("An investment in knowledge pays the best interest.", "投资知识，收益最高。", "Benjamin Franklin"),
        DailyQuote("The only true wisdom is in knowing you know nothing.", "唯一真正的智慧，是知道自己一无所知。", "Socrates"),
        DailyQuote("Reading is to the mind what exercise is to the body.", "阅读之于心灵，如同运动之于身体。", "Joseph Addison"),
        DailyQuote("A person who never made a mistake never tried anything new.", "从不犯错的人，也从不尝试新事物。", "Albert Einstein"),
        DailyQuote("It is never too late to be what you might have been.", "成为你本该成为的人，永远不嫌晚。", "George Eliot"),
        DailyQuote("The future belongs to those who believe in the beauty of their dreams.", "未来属于那些相信自己梦想之美的人。", "Eleanor Roosevelt"),
        DailyQuote("What we learn with pleasure we never forget.", "怀着乐趣学来的东西，我们永远不会忘记。", "Alfred Mercier"),
        DailyQuote("Language is the road map of a culture.", "语言是一个文化的路线图。", "Rita Mae Brown"),
        DailyQuote("Learn a new language and get a new soul.", "学会一门新语言，就拥有一个新的灵魂。", "Czech Proverb"),
    )

    /** 按一年中的第几天确定性取一条。对应 iOS `DailyQuoteBook.quote(for:)` */
    fun quote(date: LocalDate): DailyQuote {
        val dayOfYear = date.dayOfYear
        return quotes[(dayOfYear - 1) % quotes.size]
    }
}
