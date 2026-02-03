const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// Store recent events (in-memory, max 100)
const events = [];
const MAX_EVENTS = 100;

// Track active conferences for join handling
const activeConferences = new Map();

// Agent phone numbers and their ElevenLabs config
const AGENT_PHONE_NUMBERS = {
  "+18635008639": {
    phoneNumberId: "phnum_2601kgh5cqwkf3x89a64gftmggda",
    agentId: "agent_1201kgh4q7abf8n8zvfewvwyqr1e",
    agentName: "Executive Assistant"
  },
  "+13159298140": {
    phoneNumberId: "phnum_5701kgd89m62ezgsh60d29qtw80h",
    agentId: "agent_0001kg7n02e7f25bmtnb07arbmjy",
    agentName: "Jayson"
  },
};

// Connection ID for outbound calls
const OUTBOUND_CONNECTION_ID = "2883735034622117580";

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "personal-agent-webhook",
    events_stored: events.length,
    active_conferences: activeConferences.size,
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
 * Create a conference with an initial call
 * Telnyx requires a call_control_id to create a conference (auto-joins that call)
 */
async function createConference(name, callControlId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { success: false, error: "No API key" };

  try {
    const response = await fetch(
      "https://api.telnyx.com/v2/conferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name,
          beep_enabled: "never",
          call_control_id: callControlId,
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.errors?.[0]?.detail || `API error: ${response.status}`);
    }

    const data = await response.json();
    return { success: true, conferenceId: data.data.id };
  } catch (error) {
    console.error("[Telnyx] Error creating conference:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Join a call to a conference
 */
async function joinConference(conferenceId, callControlId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { success: false, error: "No API key" };

  try {
    const response = await fetch(
      `https://api.telnyx.com/v2/conferences/${conferenceId}/actions/join`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          call_control_id: callControlId,
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.errors?.[0]?.detail || `API error: ${response.status}`);
    }

    return { success: true };
  } catch (error) {
    console.error("[Telnyx] Error joining conference:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Dial out to ElevenLabs SIP and get call_control_id
 */
async function dialElevenLabsSIP(phoneNumberId, fromNumber) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { success: false, error: "No API key" };

  try {
    const sipUri = `sip:${phoneNumberId}@sip.rtc.elevenlabs.io:5061;transport=tls`;
    console.log(`[Telnyx] Dialing ElevenLabs SIP: ${sipUri}`);

    const response = await fetch(
      "https://api.telnyx.com/v2/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connection_id: OUTBOUND_CONNECTION_ID,
          to: sipUri,
          from: fromNumber,
          answering_machine_detection: "disabled",
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.errors?.[0]?.detail || `API error: ${response.status}`);
    }

    const data = await response.json();
    return { success: true, callControlId: data.data.call_control_id };
  } catch (error) {
    console.error("[Telnyx] Error dialing ElevenLabs:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Handle inbound call - conference-based approach
 * 1. Answer the call
 * 2. Create conference
 * 3. Join caller to conference
 * 4. Dial ElevenLabs (outbound)
 * 5. Join ElevenLabs to same conference when it answers
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

  // Step 1: Answer the call
  console.log(`[Webhook] Answering call...`);
  const answerResult = await answerCall(callControlId);
  if (!answerResult.success) {
    console.error(`[Webhook] Failed to answer: ${answerResult.error}`);
    return;
  }

  // Step 2: Create conference with caller already joined
  // Telnyx requires call_control_id to create conference (auto-joins that call)
  const confName = `call_${Date.now()}`;
  console.log(`[Webhook] Creating conference: ${confName} with caller`);
  const confResult = await createConference(confName, callControlId);
  if (!confResult.success) {
    console.error(`[Webhook] Failed to create conference: ${confResult.error}`);
    return;
  }
  console.log(`[Webhook] Conference created, caller auto-joined: ${confResult.conferenceId}`);

  // Step 4: Dial ElevenLabs
  console.log(`[Webhook] Dialing ElevenLabs ${agentConfig.agentName}...`);
  const dialResult = await dialElevenLabsSIP(agentConfig.phoneNumberId, to);
  if (!dialResult.success) {
    console.error(`[Webhook] Failed to dial ElevenLabs: ${dialResult.error}`);
    return;
  }

  // Store conference info for when ElevenLabs answers
  activeConferences.set(dialResult.callControlId, {
    conferenceId: confResult.conferenceId,
    callerCallControlId: callControlId,
    agentName: agentConfig.agentName,
    from: from,
    to: to,
    createdAt: new Date().toISOString(),
  });

  console.log(`[Webhook] Waiting for ElevenLabs to answer. Conference: ${confResult.conferenceId}`);
}

/**
 * Handle call.answered - join ElevenLabs to conference when it picks up
 */
async function handleCallAnswered(payload) {
  const callControlId = payload?.call_control_id;

  // Check if this is an ElevenLabs call we're tracking
  const confInfo = activeConferences.get(callControlId);
  if (!confInfo) {
    return; // Not an ElevenLabs call we initiated
  }

  console.log(`[Webhook] ElevenLabs answered! Joining to conference ${confInfo.conferenceId}`);

  // Join ElevenLabs call to the conference
  const joinResult = await joinConference(confInfo.conferenceId, callControlId);
  if (!joinResult.success) {
    console.error(`[Webhook] Failed to join ElevenLabs to conference: ${joinResult.error}`);
    return;
  }

  console.log(`[Webhook] Call connected! Caller <-> ${confInfo.agentName} (conference: ${confInfo.conferenceId})`);
}

/**
 * Handle call.hangup - cleanup
 */
function handleCallHangup(payload) {
  const callControlId = payload?.call_control_id;

  // Remove from tracking if it's an ElevenLabs call
  if (activeConferences.has(callControlId)) {
    console.log(`[Webhook] ElevenLabs call ended, cleaning up conference tracking`);
    activeConferences.delete(callControlId);
  }
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

  // Handle different event types
  if (data.event_type === "call.initiated") {
    handleInboundCall(data.payload).catch(err => {
      console.error("[Webhook] Error handling inbound call:", err.message);
    });
  } else if (data.event_type === "call.answered") {
    handleCallAnswered(data.payload).catch(err => {
      console.error("[Webhook] Error handling call answered:", err.message);
    });
  } else if (data.event_type === "call.hangup") {
    handleCallHangup(data.payload);
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

// Get active conferences
app.get("/conferences", (req, res) => {
  const confs = Array.from(activeConferences.entries()).map(([callControlId, info]) => ({
    elevenLabsCallControlId: callControlId,
    ...info,
  }));
  res.json({ success: true, conferences: confs });
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
  console.log(`Conferences endpoint: GET /conferences`);
  if (process.env.TELNYX_API_KEY) {
    console.log(`Telnyx API key configured - will handle inbound calls`);
  } else {
    console.log(`WARNING: No TELNYX_API_KEY - inbound call handling disabled`);
  }
});
