const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// Store recent events (in-memory, max 100)
const events = [];
const MAX_EVENTS = 100;

// Agent phone numbers and their ElevenLabs phone_number_ids
const AGENT_PHONE_NUMBERS = {
  "+18635008639": { phoneNumberId: "phnum_2601kgh5cqwkf3x89a64gftmggda", agentName: "Executive Assistant" },
  "+13159298140": { phoneNumberId: "phnum_5701kgd89m62ezgsh60d29qtw80h", agentName: "Jayson" },
};

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "personal-agent-webhook",
    events_stored: events.length,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Answer a call via Telnyx API
 */
async function answerCall(callControlId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    console.error("[Telnyx] No API key configured");
    return { success: false, error: "No API key" };
  }

  try {
    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.errors?.[0]?.detail || `API error: ${response.status}`);
    }

    return { success: true };
  } catch (error) {
    console.error("[Telnyx] Error answering call:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Speak a message on the call
 */
async function speakMessage(callControlId, message) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { success: false, error: "No API key" };

  try {
    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: message,
          voice: "female",
          language: "en-US",
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.errors?.[0]?.detail || `API error: ${response.status}`);
    }

    return { success: true };
  } catch (error) {
    console.error("[Telnyx] Error speaking:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Transfer call to ElevenLabs via SIP
 */
async function transferToElevenLabsSIP(callControlId, phoneNumberId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    console.error("[Telnyx] No API key configured");
    return { success: false, error: "No API key" };
  }

  try {
    // ElevenLabs SIP endpoint format
    const sipUri = `sip:${phoneNumberId}@sip.rtc.elevenlabs.io:5061;transport=tls`;
    console.log(`[Telnyx] Transferring call ${callControlId} to ElevenLabs SIP: ${sipUri}`);

    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: sipUri }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.errors?.[0]?.detail || `API error: ${response.status}`);
    }

    return { success: true };
  } catch (error) {
    console.error("[Telnyx] Error transferring to ElevenLabs:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Handle inbound call - answer and transfer to ElevenLabs
 */
async function handleInboundCall(payload) {
  const callControlId = payload?.call_control_id;
  const to = payload?.to;
  const from = payload?.from;
  const direction = payload?.direction;

  if (!callControlId || (direction !== "inbound" && direction !== "incoming")) {
    return;
  }

  // Check if this is a call to one of our agent numbers
  const agentConfig = AGENT_PHONE_NUMBERS[to];
  if (!agentConfig) {
    console.log(`[Webhook] Inbound call to ${to} - not an agent number, ignoring`);
    return;
  }

  console.log(`[Webhook] Inbound call from ${from} to ${agentConfig.agentName} (${to})`);

  // Transfer directly to ElevenLabs without answering
  // This keeps the caller hearing ring tone until ElevenLabs answers
  console.log(`[Webhook] Transferring to ElevenLabs ${agentConfig.agentName}...`);
  const transferResult = await transferToElevenLabsSIP(callControlId, agentConfig.phoneNumberId);
  if (!transferResult.success) {
    console.error(`[Webhook] Failed to transfer: ${transferResult.error}`);
    return;
  }

  console.log(`[Webhook] Call successfully transferred to ElevenLabs ${agentConfig.agentName}`);
}

// Receive Telnyx webhooks
app.post("/telnyx-webhook", async (req, res) => {
  const { data } = req.body;

  if (!data) {
    return res.status(400).json({ error: "No data" });
  }

  const event = {
    id: `evt_${Date.now()}`,
    received_at: new Date().toISOString(),
    event_type: data.event_type,
    payload: data.payload,
    raw: data,
  };

  console.log(`[Webhook] Received: ${data.event_type}`, JSON.stringify(data.payload, null, 2));

  // Add to events array (FIFO)
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.pop();
  }

  // Handle call.initiated events for inbound calls
  if (data.event_type === "call.initiated") {
    handleInboundCall(data.payload).catch(err => {
      console.error("[Webhook] Error handling inbound call:", err.message);
    });
  }

  // Forward to command-center if URL is configured
  const forwardUrl = process.env.FORWARD_WEBHOOK_URL;
  if (forwardUrl) {
    fetch(forwardUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    }).catch((err) => console.error("[Forward] Error:", err.message));
  }

  res.json({ success: true, event_id: event.id });
});

// Get recent events (for polling)
app.get("/events", (req, res) => {
  const since = req.query.since;
  const eventType = req.query.type;

  let filtered = events;

  if (since) {
    filtered = filtered.filter((e) => new Date(e.received_at) > new Date(since));
  }

  if (eventType) {
    filtered = filtered.filter((e) => e.event_type === eventType);
  }

  res.json({
    success: true,
    count: filtered.length,
    events: filtered.slice(0, 50),
  });
});

// Get a specific event
app.get("/events/:id", (req, res) => {
  const event = events.find((e) => e.id === req.params.id);
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  res.json({ success: true, event });
});

// Clear events (for testing)
app.delete("/events", (req, res) => {
  events.length = 0;
  res.json({ success: true, message: "Events cleared" });
});

app.listen(PORT, () => {
  console.log(`Personal Agent Webhook server running on port ${PORT}`);
  console.log(`Webhook endpoint: POST /telnyx-webhook`);
  console.log(`Events endpoint: GET /events`);
  if (process.env.TELNYX_API_KEY) {
    console.log(`Telnyx API key configured - will handle inbound calls`);
  } else {
    console.log(`WARNING: No TELNYX_API_KEY - inbound call handling disabled`);
  }
});
