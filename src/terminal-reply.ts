import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";

function localHost(host: string): string {
  switch (host) {
    case "0.0.0.0": return "127.0.0.1";
    case "::": return "[::1]";
    case "::1": return "[::1]";
    case "localhost":
    case "127.0.0.1": return host;
    default: throw new Error("Terminal replies require HOST to be a loopback or wildcard address");
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.terminalReplyTo) {
    throw new Error("Set WHATSAPP_REPLY_TO to the customer's WhatsApp number in .env");
  }
  if (config.terminalReplyTo === config.twilio.whatsappNumber) {
    throw new Error("WHATSAPP_REPLY_TO must be the customer's WhatsApp number, not TWILIO_WHATSAPP_NUMBER");
  }
  if (!config.manualReplyApiToken) {
    throw new Error("Set WHATSAPP_REPLY_API_TOKEN in .env to enable the reply API");
  }

  const baseUrl = `http://${localHost(config.host)}:${config.port}`;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  terminal.setPrompt("Message> ");
  console.log(
    `Sending to ${config.terminalReplyTo}. Type a message and press Enter; ` +
    "type /qr <amount> to send the Paytm QR; type /quit to exit.",
  );
  terminal.prompt();

  for await (const line of terminal) {
    const input = line.trim();
    if (input === "/quit") {
      break;
    }
    let path: string;
    let payload: Record<string, string>;
    const qrCommand = /^\/qr(?:\s+(.*))?$/.exec(input);
    if (qrCommand) {
      const amount = qrCommand[1]?.trim();
      if (!amount) {
        console.error("Usage: /qr <amount>, e.g. /qr 250");
        terminal.prompt();
        continue;
      }
      path = "/messages/whatsapp/payment-qr";
      payload = { to: config.terminalReplyTo, amount };
    } else if (input.startsWith("/")) {
      console.error("Unknown command. Use /qr <amount> or /quit.");
      terminal.prompt();
      continue;
    } else if (!input) {
      console.error("Message cannot be empty.");
      terminal.prompt();
      continue;
    } else {
      path = "/messages/whatsapp";
      payload = { to: config.terminalReplyTo, body: line };
    }

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.manualReplyApiToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      if (response.status !== 202) {
        console.error(`Reply not confirmed (HTTP ${response.status}): ${text}`);
        if (response.status >= 500) {
          console.error("Check backend logs and Twilio before retrying; the submission outcome may be unknown.");
        }
        process.exitCode = 1;
      } else {
        const result: unknown = JSON.parse(text);
        if (
          typeof result !== "object" || result === null ||
          !("messageSid" in result) || typeof result.messageSid !== "string" ||
          !("status" in result) || typeof result.status !== "string"
        ) {
          throw new Error("The reply API returned an invalid response");
        }
        console.log(`Accepted by Twilio: ${result.messageSid} (${result.status}); delivery is not yet confirmed.`);
      }
    } catch (error) {
      console.error(
        "Reply not confirmed. Check that the server is running and check Twilio before retrying:",
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    }
    terminal.prompt();
  }
  terminal.close();
}

try {
  await main();
} catch (error) {
  console.error("Cannot start terminal replies:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
