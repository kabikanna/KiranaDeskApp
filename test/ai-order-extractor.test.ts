import assert from "node:assert/strict";
import { test } from "node:test";
import { createAzureOpenAiOrderExtractor } from "../src/services/ai-order-extractor.ts";

const CONFIG = {
  endpoint: "https://kirana.openai.azure.com",
  apiKey: "test-key",
  deployment: "gpt-4.1-mini",
  apiVersion: "2024-10-21",
};

const completion = (content: string, status = 200): Response =>
  Response.json({ choices: [{ message: { content } }] }, { status });

test("calls the Azure OpenAI deployment and normalizes and merges the extracted items", async () => {
  let request: { url: string; init: RequestInit | undefined } | undefined;
  const extractor = createAzureOpenAiOrderExtractor(CONFIG, {
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return completion(JSON.stringify({ items: [
        { tamil: "அரிசி", english: "Rice", quantity: 2, unit: "kg" },
        { tamil: "அரிசி", english: "rice ", quantity: 1, unit: "kg" },
        { tamil: "பால்", english: "milk", quantity: 1, unit: "packet" },
      ] }));
    },
  });
  assert.deepEqual(await extractor.extract("rendu kilo arisi, oru kilo arisi, oru paal packet"), [
    { name: "rice", tamilName: "அரிசி", quantity: 3, unit: "kg" },
    { name: "milk", tamilName: "பால்", quantity: 1, unit: "pack" },
  ]);
  assert.equal(
    request?.url,
    "https://kirana.openai.azure.com/openai/deployments/gpt-4.1-mini/chat/completions?api-version=2024-10-21",
  );
  assert.equal((request?.init?.headers as Record<string, string>)["api-key"], "test-key");
  const body = JSON.parse(String(request?.init?.body)) as { messages: { role: string; content: string }[] };
  assert.equal(body.messages[1]?.content, "rendu kilo arisi, oru kilo arisi, oru paal packet");
});

test("rejects HTTP errors and invalid model output", async () => {
  const failing = createAzureOpenAiOrderExtractor(CONFIG, { fetchImpl: async () => completion("{}", 429) });
  await assert.rejects(failing.extract("rice 1kg"), /HTTP 429/);
  const invalid = createAzureOpenAiOrderExtractor(CONFIG, {
    fetchImpl: async () => completion(JSON.stringify({ items: [{ tamil: "", english: "rice", quantity: -1, unit: "kg" }] })),
  });
  await assert.rejects(invalid.extract("rice"), /invalid item/);
});
