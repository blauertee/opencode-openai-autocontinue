import http from "node:http"
// Answers like a ChatGPT subscription backend whose usage limit resets RESET_IN
// seconds after start: 429 `usage_limit_reached` (with `resets_at`) until then,
// a one-line streamed Responses API answer afterwards. Also serves wham/usage.
const resetIn = Number(process.env.RESET_IN ?? 40)
const port = Number(process.env.PORT ?? 18080)
const resetAt = Math.floor(Date.now() / 1000) + resetIn
const log = (...a) => console.log(new Date().toISOString(), ...a)
http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    log(req.method, req.url, body.length)
    if (req.url.includes("wham/usage")) {
      const blocked = Date.now() / 1000 < resetAt
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ rate_limit: { allowed: !blocked, limit_reached: blocked, primary_window: { used_percent: blocked ? 100 : 1, reset_at: resetAt } } }))
    }
    if (!req.url.endsWith("/responses") || req.method !== "POST") { res.writeHead(404); return res.end("{}") }

    if (Date.now() / 1000 < resetAt) {
      log("-> 429 usage_limit_reached, resets_at", resetAt)
      res.writeHead(429, { "content-type": "application/json", "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String(resetAt) })
      return res.end(JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: resetAt } }))
    }
    log("-> 200 stream")
    res.writeHead(200, { "content-type": "text/event-stream" })
    const id = "resp_" + Date.now(), item = "msg_" + Date.now()
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    const response = { id, object: "response", created_at: Math.floor(Date.now()/1000), model: "gpt-5.5", status: "in_progress", output: [] }
    send("response.created", { response })
    send("response.output_item.added", { output_index: 0, item: { id: item, type: "message", role: "assistant", status: "in_progress", content: [] } })
    send("response.content_part.added", { item_id: item, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
    send("response.output_text.delta", { item_id: item, output_index: 0, content_index: 0, delta: "RESUMED-OK" })
    send("response.output_text.done", { item_id: item, output_index: 0, content_index: 0, text: "RESUMED-OK" })
    const msg = { id: item, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "RESUMED-OK", annotations: [] }] }
    send("response.output_item.done", { output_index: 0, item: msg })
    send("response.completed", { response: { ...response, status: "completed", output: [msg], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
    res.end()
  })
}).listen(port, () => log("mock up, reset at", resetAt))
