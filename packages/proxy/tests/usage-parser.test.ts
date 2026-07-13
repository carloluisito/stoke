import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonResponse,
  parseSseStream,
  parseRateLimitHeaders,
} from "../src/usage-parser.ts";

test("parseJsonResponse extracts usage from a max_tokens:0 response", () => {
  const body = JSON.stringify({
    model: "claude-opus-4-7",
    content: [],
    stop_reason: "max_tokens",
    usage: {
      input_tokens: 2,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 61325,
    },
  });
  const got = parseJsonResponse(body);
  assert.ok(got);
  assert.equal(got!.cache_read_input_tokens, 61325);
});

test("parseSseStream extracts usage from message_delta events", () => {
  const sse =
    `event: message_start\n` +
    `data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":5000}}}\n\n` +
    `event: message_delta\n` +
    `data: {"type":"message_delta","usage":{"output_tokens":42,"input_tokens":10,"cache_read_input_tokens":5000,"cache_creation_input_tokens":0}}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const got = parseSseStream(sse);
  assert.ok(got);
  assert.equal(got!.cache_read_input_tokens, 5000);
  assert.equal(got!.output_tokens, 42);
});

test("parseRateLimitHeaders extracts unified fields", () => {
  const headers = {
    "anthropic-ratelimit-unified-5h-utilization": "0.03",
    "anthropic-ratelimit-unified-7d-utilization": "0.13",
    "anthropic-ratelimit-unified-5h-reset": "1779145800",
    "anthropic-ratelimit-unified-overage-status": "rejected",
  };
  const got = parseRateLimitHeaders(headers);
  assert.equal(got.unified5hUtilization, 0.03);
  assert.equal(got.unified7dUtilization, 0.13);
  assert.equal(got.unified5hResetEpoch, 1779145800);
  assert.equal(got.overageStatus, "rejected");
});

test("parseRateLimitHeaders returns nulls when missing", () => {
  const got = parseRateLimitHeaders({});
  assert.equal(got.unified5hUtilization, null);
  assert.equal(got.overageStatus, null);
});
