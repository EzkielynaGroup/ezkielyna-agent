// Round-4 review (H-1, H-2, M-7): everything the beta bug report must never print. K is a random 20-character value without any known prefix.
import { describe, expect, test } from "bun:test"
import { LOG_LINE_LIMIT, redactBugReport, renderBugReport, sanitizeLogLine } from "../../../src/ezk/diag/report"
import { redactSecrets } from "../../../src/ezkielyna-redact"

const K = "Zq9xLm2PvT7wRk4Nc8Yh"
const SK = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4"
const b64 = (value: string) => Buffer.from(value).toString("base64")
const UNIX_HOME = "/Users/bob"
const WIN_HOME = "C:\\Users\\jdoe"

type Case = { name: string; line: string; secret: string; home?: string }
const CORPUS: Case[] = [
  { name: "Bearer", line: `Authorization: Bearer ${K}`, secret: K },
  { name: "Authorization: Token <k>", line: `authorization: Token ${K}`, secret: K },
  { name: "Authorization: ApiKey <k>", line: `Authorization: ApiKey ${K}`, secret: K },
  { name: "Authorization: Basic b64", line: `Authorization: Basic ${b64(`user:${K}`)}`, secret: b64(`user:${K}`) },
  { name: "JSON {Authorization: Bearer}", line: `{"Authorization":"Bearer ${K}"}`, secret: K },
  { name: "JSON {authorization: raw}", line: `{"authorization":"${K}"}`, secret: K },
  { name: "JSON {x-api-key}", line: `{"x-api-key":"${K}"}`, secret: K },
  { name: "x-api-key header", line: `x-api-key: ${K}`, secret: K },
  { name: "Azure api-key header", line: `api-key: ${K}`, secret: K },
  { name: "x-goog-api-key header", line: `x-goog-api-key: ${K}`, secret: K },
  { name: "Cookie header", line: `Cookie: session=${K}; theme=dark`, secret: K },
  { name: "Set-Cookie header", line: `Set-Cookie: sid=${K}; HttpOnly`, secret: K },
  { name: "url ?key=", line: `GET https://h/v1/models?key=${K} 401`, secret: K },
  { name: "url ?api_key=&", line: `GET https://h/v1/models?api_key=${K}&x=1`, secret: K },
  { name: "url &Token=", line: `GET https://h/p?a=1&Token=${K}`, secret: K },
  { name: "url ?sig=", line: `GET https://h/p?sig=${K}`, secret: K },
  { name: "url ?signature=", line: `GET https://h/p?signature=${K}&expires=1`, secret: K },
  { name: "url ?code= (oauth)", line: `GET https://h/cb?code=${K}&state=x`, secret: K },
  { name: "url ?apikey= (no separator)", line: `GET https://h/p?apikey=${K}`, secret: K },
  { name: "url-encoded key%3D", line: `GET https://h/p?x=1%26key%3D${K}`, secret: K },
  { name: "url-encoded sk key", line: `GET https://h/p?x=1%26key%3D${SK}`, secret: SK },
  { name: "basic-auth in URL (special chars)", line: `proxy error: http://user:p%40ss!${K}!@proxy.corp:8080 refused`, secret: K },
  { name: "basic-auth in URL (alnum)", line: `proxy error: http://user:${K}@proxy.corp:8080 refused`, secret: K },
  { name: "token-only URL user info", line: `git fetch https://${K}@github.com/o/r.git failed`, secret: K },
  { name: "telegram bot url", line: `POST https://api.telegram.org/bot123456789:${K}/getUpdates`, secret: K },
  { name: "ENV OPENAI_API_KEY=", line: `OPENAI_API_KEY=${K}`, secret: K },
  { name: "ENV GEMINI_API_KEY=", line: `GEMINI_API_KEY=${K}`, secret: K },
  { name: "ENV DB_PASSWORD=", line: `DB_PASSWORD=${K}`, secret: K },
  { name: "ENV client_secret=", line: `client_secret=${K}`, secret: K },
  { name: "ENV AWS_SECRET_ACCESS_KEY=", line: `AWS_SECRET_ACCESS_KEY=${K}`, secret: K },
  { name: "ENV quoted GITHUB_TOKEN", line: `GITHUB_TOKEN="${K}"`, secret: K },
  { name: "JSON apiKey", line: `{"apiKey":"${K}"}`, secret: K },
  { name: "JSON api_key", line: `{"api_key":"${K}"}`, secret: K },
  { name: "JSON password", line: `{"password":"${K}"}`, secret: K },
  { name: "JSON token", line: `{"token":"${K}"}`, secret: K },
  { name: "JSON secret", line: `{"clientSecret":"${K}"}`, secret: K },
  { name: "JSON session", line: `{"sessionToken":"${K}"}`, secret: K },
  { name: "JSON-escaped (logfmt-quoted) JSON", line: `body="{\\"apiKey\\":\\"${K}\\"}"`, secret: K },
  { name: "JSON-escaped password", line: `cause="{\\"password\\":\\"${K}\\"}"`, secret: K },
  { name: "sk- key", line: `error key ${SK} invalid`, secret: SK },
  { name: "sk- key JSON-escaped", line: `body="{\\"key\\":\\"${SK}\\"}"`, secret: SK },
  { name: "sk- key after word char", line: `mykey_${SK}`, secret: SK },
  { name: "sk- key after letters", line: `token${SK}`, secret: SK },
  { name: "sk- key with unicode escape", line: `\\u0073k-${SK.slice(3)}`, secret: SK.slice(3) },
  { name: "sk- short (7 chars) in a key pair", line: "key=sk-abcdefg", secret: "abcdefg" },
  { name: "sk- split by \\n in logfmt", line: `message="bad key sk-${SK.slice(3, 8)}\\n${SK.slice(8)}"`, secret: SK.slice(8) },
  { name: "ezk- key", line: `used ezk-${SK.slice(3)}`, secret: SK.slice(3) },
  { name: "sk_live_", line: `sk_live_${K}${K}`, secret: K },
  { name: "ghp_ token", line: `token ghp_${K}${K.slice(0, 16)}`, secret: K },
  { name: "github_pat_", line: `github_pat_11A${K}_${K}`, secret: K },
  { name: "AIza google key", line: `AIzaSy${K}${K.slice(0, 13)}`, secret: K },
  { name: "AKIA aws key id", line: "AKIA" + "IOSFODNN7EXAMPLE", secret: "AKIA" + "IOSFODNN7EXAMPLE" },
  { name: "xoxb slack", line: `xoxb-${""}1234567890-${K}`, secret: K },
  { name: "JWT", line: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${K}${K}`, secret: K },
  { name: "hf_ token", line: `hf_${K}${K.slice(0, 14)}`, secret: K },
  { name: "gsk_ groq", line: `gsk_${K}${K}${K.slice(0, 12)}`, secret: K },
  { name: "xai- key", line: `xai-${K}${K}`, secret: K },
  { name: "private key block", line: `-----BEGIN${""} PRIVATE KEY-----${K}${K}-----END PRIVATE KEY-----`, secret: K },
  { name: "email plain", line: "user alice.smith@example.com failed", secret: "alice.smith" },
  { name: "email plus", line: "user alice+beta@example.com failed", secret: "alice" },
  { name: "email unicode local", line: "user josé.garcía@example.com failed", secret: "garc" },
  { name: "home unix", line: `open ${UNIX_HOME}/proj/src/a.ts failed`, secret: "bob", home: UNIX_HOME },
  { name: "home unix other case", line: "open /users/BOB/proj failed", secret: "BOB", home: UNIX_HOME },
  { name: "home unix, home not provided", line: "open /Users/zed/proj failed", secret: "zed" },
  { name: "home linux, home not provided", line: "open /home/zed/proj failed", secret: "zed" },
  { name: "home win backslash", line: `open ${WIN_HOME}\\proj\\a.ts failed`, secret: "jdoe", home: WIN_HOME },
  { name: "home win JSON-escaped \\\\", line: 'path="C:\\\\Users\\\\jdoe\\\\proj\\\\a.ts"', secret: "jdoe", home: WIN_HOME },
  { name: "home win JSON-escaped, home not provided", line: 'path="C:\\\\Users\\\\jdoe\\\\proj\\\\a.ts"', secret: "jdoe" },
  { name: "home win forward slash", line: "open C:/Users/jdoe/proj/a.ts", secret: "jdoe", home: WIN_HOME },
  { name: "home win file URL", line: "file:///C:/Users/jdoe/proj/a.ts", secret: "jdoe", home: WIN_HOME },
  { name: "home win git-bash /c/Users", line: "cwd=/c/Users/jdoe/proj", secret: "jdoe", home: WIN_HOME },
  { name: "home win WSL /mnt/c", line: "cwd=/mnt/c/Users/jdoe/proj", secret: "jdoe", home: WIN_HOME },
  { name: "home win git-bash, home not provided", line: "cwd=/c/Users/jdoe/proj", secret: "jdoe" },
  { name: "home win 8.3 short", line: "C:\\Users\\JDOE~1\\AppData", secret: "JDOE~1", home: WIN_HOME },
  { name: "home win lower drive", line: "c:\\users\\jdoe\\x", secret: "jdoe", home: WIN_HOME },
  { name: "home with spaces", line: "open C:\\Users\\Jane Q Public\\proj\\a.ts", secret: "Public", home: "C:\\Users\\Jane Q Public" },
  { name: "home percent-encoded", line: "file%3A%2F%2F%2FUsers%2Fbob%2Fproj", secret: "bob", home: UNIX_HOME },
  { name: "home expanded from %USERPROFILE%", line: "cache=C:\\Users\\jdoe\\AppData\\Local\\ezkielyna", secret: "jdoe", home: WIN_HOME },
]

// How the real log writer stores a value (packages/core/src/observability/logging.ts): JSON-stringified when it has \, " or whitespace,
// then run through the shared redactor per key=value pair.
const fmt = (value: string) => (/^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value))
const asLogLine = (line: string) => ["timestamp=2026-10-22T06:00:00.000Z", "level=Error", `message=${fmt(line)}`].map(redactSecrets).join(" ")
const render = (logLines: string[], home?: string) =>
  renderBugReport({
    language: "en",
    generatedAt: "t",
    version: "1.19.3-ezk.6",
    channel: "beta",
    os: "Windows_NT 10.0",
    arch: "x64",
    locale: "id-ID",
    checks: [],
    enabledFlags: [],
    models: [],
    keyPresent: true,
    logLines,
    homeDir: home,
  })

describe("bug report redaction corpus (round-4 review)", () => {
  test("the corpus is large enough to matter", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(65)
  })

  for (const item of CORPUS) {
    test(`redactBugReport: ${item.name}`, () => {
      const out = redactBugReport(item.line, item.home)
      expect(out).not.toContain(item.secret)
    })

    test(`rendered report, line as written by the log writer: ${item.name}`, () => {
      const out = render([asLogLine(item.line)], item.home)
      expect(out).not.toContain(item.secret)
    })
  }

  test("the same corpus in one block leaks nothing (secrets next to each other)", () => {
    const out = redactBugReport(CORPUS.map((item) => item.line).join("\n"), WIN_HOME, { userName: "jdoe" })
    for (const item of CORPUS) if (item.home === undefined || item.home === WIN_HOME) expect(out).not.toContain(item.secret)
  })
})

describe("bug report redaction: home folder and account name", () => {
  test("every spelling of a Windows home is replaced, including the JSON-escaped form of a real log line", () => {
    const line = asLogLine("failed to read C:\\Users\\jdoe\\Projects\\acme-billing\\.env")
    expect(line).toContain("C:\\\\Users\\\\jdoe") // as stored on disk
    const out = render([line], WIN_HOME)
    expect(out).not.toContain("jdoe")
    expect(out).toContain("~")
    expect(out).toContain("acme-billing") // only the account is hidden, not the project
  })

  test("USERPROFILE/HOME spellings and the account name are honoured", () => {
    const out = redactBugReport("owner=jdoe path=D:\\profiles\\jdoe\\x", "C:\\Users\\jdoe", { homeDirs: ["D:\\profiles\\jdoe"], userName: "jdoe" })
    expect(out).not.toContain("jdoe")
  })

  test("does not mangle look-alike paths or short account names", () => {
    expect(redactBugReport("see src/Users/Profile.ts and /srv/home/page", UNIX_HOME)).toBe("see src/Users/Profile.ts and /srv/home/page")
    expect(redactBugReport("macOS machine mac", UNIX_HOME, { userName: "mac" })).toBe("macOS machine <user>")
  })
})

describe("bug report redaction: nothing useful is blurred", () => {
  test("fixed labels, identifiers and ordinary words survive", () => {
    const report = render(
      [
        "timestamp=2026-10-22T06:00:00.000Z level=Error run=r1 service=ezk-router session.id=ses_123 message=\"disk-usage-info high, retrying\"",
      ],
      UNIX_HOME,
    )
    expect(report).toContain("API key: present")
    expect(report).toContain("service=ezk-router")
    expect(report).toContain("session.id=ses_123")
    expect(report).toContain("disk-usage-info high, retrying")
  })
})

describe("bug report log lines (M-7)", () => {
  const aiError =
    'timestamp=2026-10-22T06:00:00.000Z level=Error service=llm message="AI_APICallError: Bad Request" ' +
    'cause="{\\"requestBodyValues\\":{\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"my private source code\\"}]},\\"responseBody\\":\\"echo my private source code\\"}" ' +
    'error.requestBodyValues.messages="my private source code" prompt="write me the billing module" request.headers="{}" status=400'

  test("drops request/response bodies and prompt text but keeps level, message and status", () => {
    const kept = sanitizeLogLine(aiError)
    expect(kept).not.toContain("private source code")
    expect(kept).not.toContain("billing module")
    expect(kept).toContain("level=Error")
    expect(kept).toContain("AI_APICallError: Bad Request")
    expect(kept).toContain("status=400")
    const out = render([aiError])
    expect(out).not.toContain("private source code")
    expect(out).not.toContain("billing module")
    expect(out).toContain("status=400")
  })

  test("a body marker inside plain text cuts the rest of the line", () => {
    const out = render(['WARN request failed requestBodyValues: {"messages":[{"content":"secret plan"}]}'])
    expect(out).not.toContain("secret plan")
    expect(out).toContain("[body omitted]")
  })

  test("every log line is at most 300 characters, also after redaction", () => {
    const long = `level=Error message=${JSON.stringify("x".repeat(2000))} note=${"y".repeat(2000)}`
    const out = render([long, long, long]).split("\n")
    const lines = out.slice(out.findIndex((line) => line.startsWith("Recent warnings")) + 1).filter(Boolean)
    expect(lines.length).toBe(3)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(LOG_LINE_LIMIT)
  })

  test("the last failed request is bounded and cleaned too", () => {
    const out = renderBugReport({
      language: "en",
      generatedAt: "t",
      version: "v",
      channel: "beta",
      os: "o",
      arch: "a",
      locale: "l",
      checks: [],
      enabledFlags: [],
      models: [],
      keyPresent: true,
      logLines: [],
      lastFailedRequest: { status: 500, error: `${aiError} ${"z".repeat(1000)}` },
    })
    const line = out.split("\n").find((entry) => entry.startsWith("Last failed request"))!
    expect(line).not.toContain("private source code")
    expect(line.length).toBeLessThanOrEqual(LOG_LINE_LIMIT + 40)
  })
})
