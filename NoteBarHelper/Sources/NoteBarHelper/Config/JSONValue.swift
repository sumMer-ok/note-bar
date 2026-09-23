import Foundation

/// 只承载 JSON 的极简值类型。
///
/// 为什么不用 `[String: Any]`：词典是外部文件，字段类型不可信；插件侧 `deepMerge` 的语义
/// 是「对象递归合并、其他类型直接覆盖」，用枚举把类型显式化，才可能把这套语义写成纯函数并单测。
public enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init?(any value: Any) {
        switch value {
        case is NSNull:
            self = .null
        case let number as NSNumber:
            // Bool 在 Foundation 里也是 NSNumber，必须先判别
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else if number.doubleValue == number.doubleValue.rounded(), number.doubleValue.magnitude < 1e15 {
                self = .int(number.intValue)
            } else {
                self = .double(number.doubleValue)
            }
        case let string as String:
            self = .string(string)
        case let array as [Any]:
            var converted: [JSONValue] = []
            converted.reserveCapacity(array.count)
            for item in array {
                guard let value = JSONValue(any: item) else { return nil }
                converted.append(value)
            }
            self = .array(converted)
        case let dict as [String: Any]:
            var converted: [String: JSONValue] = [:]
            converted.reserveCapacity(dict.count)
            for (key, item) in dict {
                guard let value = JSONValue(any: item) else { return nil }
                converted[key] = value
            }
            self = .object(converted)
        default:
            return nil
        }
    }

    /// 已解析的 JSON 对象（`JSONSerialization` 的产物类型）
    public init?(jsonObject: Any) {
        self.init(any: jsonObject)
    }

    public init?(jsonData: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: jsonData, options: [.fragmentsAllowed]) else { return nil }
        self.init(any: object)
    }

    public init?(jsonString: String) {
        self.init(jsonData: Data(jsonString.utf8))
    }

    public var objectValue: [String: JSONValue]? {
        if case let .object(dict) = self { return dict }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(items) = self { return items }
        return nil
    }

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    /// JSONSerialization 可接受的等价表示（写请求体用）
    public var anyValue: Any {
        switch self {
        case .null: return NSNull()
        case let .bool(value): return value
        case let .int(value): return value
        case let .double(value): return value
        case let .string(value): return value
        case let .array(items): return items.map(\.anyValue)
        case let .object(dict): return dict.mapValues(\.anyValue)
        }
    }

    /// 与插件 `DictionaryService.deepMerge` 同语义：两边都是对象则递归合并，否则右侧覆盖
    public func merged(with other: JSONValue) -> JSONValue {
        guard case let .object(base) = self, case let .object(override) = other else { return other }
        return .object(Self.mergeObjects(base, override))
    }

    private static func mergeObjects(_ base: [String: JSONValue],
                                    _ override: [String: JSONValue]) -> [String: JSONValue] {
        var output = base
        for (key, value) in override {
            if let existing = base[key] {
                output[key] = existing.merged(with: value)
            } else {
                output[key] = value
            }
        }
        return output
    }
}
