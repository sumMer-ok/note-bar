import Foundation

struct DailyQuote: Identifiable {
    let english: String
    let chinese: String
    let author: String
    var id: String { english }
}

enum DailyQuoteBook {
    static let quotes: [DailyQuote] = [
        DailyQuote(english: "The only way to do great work is to love what you do.", chinese: "成就伟业的唯一途径，就是热爱你所做的事。", author: "Steve Jobs"),
        DailyQuote(english: "Stay hungry, stay foolish.", chinese: "求知若饥，虚心若愚。", author: "Steve Jobs"),
        DailyQuote(english: "It always seems impossible until it's done.", chinese: "事情在完成之前，总是看起来不可能。", author: "Nelson Mandela"),
        DailyQuote(english: "Education is the most powerful weapon which you can use to change the world.", chinese: "教育是你可以用来改变世界的最有力的武器。", author: "Nelson Mandela"),
        DailyQuote(english: "The best time to plant a tree was 20 years ago. The second best time is now.", chinese: "种一棵树最好的时间是二十年前，其次是现在。", author: "Chinese Proverb"),
        DailyQuote(english: "Success is not final, failure is not fatal: it is the courage to continue that counts.", chinese: "成功不是终点，失败也并非末日，重要的是继续前进的勇气。", author: "Winston Churchill"),
        DailyQuote(english: "You miss 100% of the shots you don't take.", chinese: "你不挥杆，就百分之百打不中。", author: "Wayne Gretzky"),
        DailyQuote(english: "Whether you think you can or you think you can't, you're right.", chinese: "无论你认为自己能或不能，你都是对的。", author: "Henry Ford"),
        DailyQuote(english: "The journey of a thousand miles begins with a single step.", chinese: "千里之行，始于足下。", author: "Lao Tzu"),
        DailyQuote(english: "Genius is one percent inspiration and ninety-nine percent perspiration.", chinese: "天才是百分之一的灵感加上百分之九十九的汗水。", author: "Thomas Edison"),
        DailyQuote(english: "In the middle of difficulty lies opportunity.", chinese: "困难之中孕育着机遇。", author: "Albert Einstein"),
        DailyQuote(english: "Life is what happens when you're busy making other plans.", chinese: "生活就是当你忙于制定其他计划时，正在发生的一切。", author: "John Lennon"),
        DailyQuote(english: "The secret of getting ahead is getting started.", chinese: "领先的秘诀就是开始行动。", author: "Mark Twain"),
        DailyQuote(english: "Do what you can, with what you have, where you are.", chinese: "就地取材，尽力而为。", author: "Theodore Roosevelt"),
        DailyQuote(english: "Well done is better than well said.", chinese: "说得好不如做得好。", author: "Benjamin Franklin"),
        DailyQuote(english: "An investment in knowledge pays the best interest.", chinese: "投资知识，收益最高。", author: "Benjamin Franklin"),
        DailyQuote(english: "The only true wisdom is in knowing you know nothing.", chinese: "唯一真正的智慧，是知道自己一无所知。", author: "Socrates"),
        DailyQuote(english: "Reading is to the mind what exercise is to the body.", chinese: "阅读之于心灵，如同运动之于身体。", author: "Joseph Addison"),
        DailyQuote(english: "A person who never made a mistake never tried anything new.", chinese: "从不犯错的人，也从不尝试新事物。", author: "Albert Einstein"),
        DailyQuote(english: "It is never too late to be what you might have been.", chinese: "成为你本该成为的人，永远不嫌晚。", author: "George Eliot"),
        DailyQuote(english: "The future belongs to those who believe in the beauty of their dreams.", chinese: "未来属于那些相信自己梦想之美的人。", author: "Eleanor Roosevelt"),
        DailyQuote(english: "What we learn with pleasure we never forget.", chinese: "怀着乐趣学来的东西，我们永远不会忘记。", author: "Alfred Mercier"),
        DailyQuote(english: "Language is the road map of a culture.", chinese: "语言是一个文化的路线图。", author: "Rita Mae Brown"),
        DailyQuote(english: "Learn a new language and get a new soul.", chinese: "学会一门新语言，就拥有一个新的灵魂。", author: "Czech Proverb"),
    ]

    /// 按日期确定性地推荐一句（同一天固定，次日轮换）
    static func quote(for date: Date = Date()) -> DailyQuote {
        let day = Calendar.current.ordinality(of: .day, in: .year, for: date) ?? 1
        return quotes[(day - 1) % quotes.count]
    }
}
