import XCTest
import Darwin
@testable import NoteBarHelper

/// 端到端验证 AI 请求的真实形状：起一个本机 stub 服务，让 `AIDefinitionClient` 真的发一次 HTTP，
/// 断言路径 / 方法 / Authorization / 请求体，并把响应喂回解析链路。
/// 这样即使没有真实 API Key，也能证明「怎么发、怎么解」是对的。
final class AIDefinitionHTTPTests: XCTestCase {
    func testFetchPostsOpenAICompatibleRequestAndParsesFencedResponse() async throws {
        let server = try LocalHTTPServer(body: """
        {"choices":[{"message":{"role":"assistant","content":"```json\\n{\\"aliases\\":[\\"sue\\",\\"sued\\"],\\"definition\\":\\"1）音标\\\\n2）v. 起诉\\"}\\n```"}}]}
        """)
        defer { server.stop() }

        let service = AIServiceConfig(provider: nil,
                                      apiUrl: "http://127.0.0.1:\(server.port)/v1",
                                      apiKey: "test-key-not-a-real-secret",
                                      model: "stub-model",
                                      extraParams: #"{"max_tokens":8192,"top_p":0.9}"#)
        let definition = AIDefinitionConfig(enabled: true, prompt: "查 {{word}}｜句：{{sentence}}")
        let logged = LogBox()

        let parsed = try await AIDefinitionClient.fetch(service: service,
                                                        definition: definition,
                                                        word: "sue",
                                                        sentence: "He sued.",
                                                        log: { logged.append($0) })

        XCTAssertEqual(parsed.aliases, ["sue", "sued"])
        XCTAssertEqual(parsed.definition, "1）音标\n2）v. 起诉")

        let request = try XCTUnwrap(server.receivedRequest, "stub 服务没有收到请求")
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/v1/chat/completions", "apiUrl 末尾应补上 /chat/completions")
        XCTAssertEqual(request.header("authorization"), "Bearer test-key-not-a-real-secret")
        XCTAssertEqual(request.header("content-type"), "application/json")

        let body = try XCTUnwrap(JSONValue(jsonString: request.body).flatMap(\.objectValue))
        XCTAssertEqual(body["model"], .string("stub-model"))
        XCTAssertEqual(body["max_tokens"], .int(8192), "extraParams 应合并进请求体")
        XCTAssertEqual(body["top_p"], .double(0.9))
        let messages = try XCTUnwrap(body["messages"]?.arrayValue)
        XCTAssertEqual(messages.first?.objectValue?["content"], .string("查 sue｜句：He sued."),
                       "提示词占位符应替换后作为 user message")

        XCTAssertFalse(logged.lines.joined().contains("test-key-not-a-real-secret"), "日志不能含 apiKey")
    }

    func testFetchSurfacesHTTPErrorStatus() async throws {
        let server = try LocalHTTPServer(body: #"{"error":{"message":"invalid api key"}}"#, status: 401)
        defer { server.stop() }

        do {
            _ = try await AIDefinitionClient.fetch(service: AIServiceConfig(provider: nil,
                                                                            apiUrl: "http://127.0.0.1:\(server.port)/v1",
                                                                            apiKey: "bad",
                                                                            model: "m",
                                                                            extraParams: nil),
                                                   definition: AIDefinitionConfig(enabled: true, prompt: "{{word}}"),
                                                   word: "sue",
                                                   sentence: nil,
                                                   log: { _ in })
            XCTFail("401 应抛错")
        } catch {
            guard case let AIDefinition.Failure.http(status, message)? = error as? AIDefinition.Failure else {
                return XCTFail("应抛 http 失败，实际 \(error)")
            }
            XCTAssertEqual(status, 401)
            XCTAssertEqual(message?.contains("invalid api key"), true, "错误体应带给用户")
        }
    }

    func testFetchSurfacesUnparsableResponse() async throws {
        let server = try LocalHTTPServer(body: #"{"unexpected":true}"#)
        defer { server.stop() }

        do {
            _ = try await AIDefinitionClient.fetch(service: AIServiceConfig(provider: nil,
                                                                            apiUrl: "http://127.0.0.1:\(server.port)/v1",
                                                                            apiKey: "k",
                                                                            model: "m",
                                                                            extraParams: nil),
                                                   definition: AIDefinitionConfig(enabled: true, prompt: "{{word}}"),
                                                   word: "sue",
                                                   sentence: nil,
                                                   log: { _ in })
            XCTFail("缺少 choices 的响应应抛错")
        } catch {
            XCTAssertEqual((error as? AIDefinition.Failure)?.description.contains("choices") , true)
        }
    }
}

// MARK: - 本机 stub 服务

private struct StubRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: String

    func header(_ name: String) -> String? { headers[name.lowercased()] }
}

/// 只服务一个请求就够用：accept → 读完整请求（按 Content-Length）→ 回一段固定响应 → 关闭。
private final class LocalHTTPServer: @unchecked Sendable {
    let port: UInt16
    private let listenFD: Int32
    private let lock = NSLock()
    private var storedRequest: StubRequest?
    private let responseBody: String
    private let status: Int

    var receivedRequest: StubRequest? {
        lock.lock()
        defer { lock.unlock() }
        return storedRequest
    }

    init(body: String, status: Int = 200) throws {
        self.responseBody = body
        self.status = status

        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw XCTSkip("无法创建 socket") }

        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0                       // 让内核选端口
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bindResult == 0, listen(fd, 1) == 0 else {
            close(fd)
            throw XCTSkip("无法监听本机端口")
        }

        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &actual) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard nameResult == 0 else {
            close(fd)
            throw XCTSkip("无法获取监听端口")
        }
        self.port = UInt16(bigEndian: actual.sin_port)
        self.listenFD = fd

        Thread.detachNewThread { [self] in serveOnce() }
    }

    func stop() { close(listenFD) }

    private func serveOnce() {
        var clientAddress = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let client = withUnsafeMutablePointer(to: &clientAddress) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(listenFD, $0, &length) }
        }
        guard client >= 0 else { return }
        defer { close(client) }

        let raw = readAll(from: client)
        if let request = Self.parse(raw) {
            lock.lock()
            storedRequest = request
            lock.unlock()
        }

        let payload = Data(responseBody.utf8)
        let head = """
        HTTP/1.1 \(status) OK\r
        Content-Type: application/json\r
        Content-Length: \(payload.count)\r
        Connection: close\r
        \r

        """
        var response = Data(head.utf8)
        response.append(payload)
        response.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            _ = write(client, base, buffer.count)
        }
    }

    /// 读到请求头结束 + Content-Length 指定的正文长度为止
    private func readAll(from client: Int32) -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = read(client, &buffer, buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer[0..<count])
            if let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self)
                let expected = Self.contentLength(in: head)
                if data.count - headerEnd.upperBound >= expected { break }
            }
        }
        return data
    }

    private static func contentLength(in head: String) -> Int {
        for line in head.split(separator: "\r\n") where line.lowercased().hasPrefix("content-length:") {
            return Int(line.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) ?? 0
        }
        return 0
    }

    static func parse(_ data: Data) -> StubRequest? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self)
        let lines = head.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ").map(String.init)
        guard parts.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let separator = line.firstIndex(of: ":") else { continue }
            let name = line[..<separator].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        let body = String(decoding: data[headerEnd.upperBound...], as: UTF8.self)
        return StubRequest(method: parts[0], path: parts[1], headers: headers, body: body)
    }
}

/// 收集日志：`log` 闭包要求 Sendable，用一个带锁的小盒子跨线程记
private final class LogBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    func append(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        storage.append(line)
    }

    var lines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
