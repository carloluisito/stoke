export function extractTurn(line, { project }) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj?.type !== "assistant") return null;
  const msg = obj.message;
  const u = msg?.usage;
  if (!msg?.id || !u) return null;
  const bd = u.cache_creation;
  const cw5 = bd ? (bd.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
  const cw1 = bd ? (bd.ephemeral_1h_input_tokens || 0) : 0;
  return {
    message_id: msg.id,
    session_id: obj.sessionId || "unknown",
    project,
    ts: obj.timestamp || new Date(0).toISOString(),
    model: msg.model || "unknown",
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_write_5m: cw5,
    cache_write_1h: cw1,
    cache_read: u.cache_read_input_tokens || 0,
  };
}
