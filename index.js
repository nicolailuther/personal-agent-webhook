const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// Version for tracking deploys
const VERSION = "2.0.0";
const DEPLOY_TIME = new Date().toISOString();

// Store recent events (in-memory, max 100)
const events = [];
const MAX_EVENTS = 100;

// Debug log for operation results
const debugLog = [];

// Track calls pending conference setup (answered but not yet in conference)
const pendingCalls = new Map();

// Track active conferences for join handling
const activeConferences = new Map();

// Track expected ElevenLabs callbacks (for matching incoming AI calls)
// Key: "fromNumber->toNumber", Value: { conferenceId, agentName, callerFrom, timestamp }
const pendingAICallbacks = new Map();

// Agent phone numbers and their ElevenLabs config
// Both numbers now route to our Call Control App for monitoring
const AGENT_PHONE_NUMBERS = {
  "+18635008639": {
    phoneNumberId: "phnum_2601kgh5cqwkf3x89a64gftmggda",
    agentId: "agent_1201kgh4q7abf8n8zvfewvwyqr1e",
    agentName: "Executive Assistant",
    bridgeNumber: "+13159298140", // Use the OTHER number as bridge
  },
  "+13159298140": {
    phoneNumberId: "phnum_5701kgd89m62ezgsh60d29qtw80h",
    agentId: "agent_0001kg7n02e7f25bmtnb07arbmjy",
    agentName: "Jayson",
    bridgeNumber: "+18635008639", // Use the OTHER number as bridge
  },
};

// Connection ID for outbound calls (Call Control Application with webhook URL configured)
const OUTBOUND_CONNECTION_ID = "2887328154249069899";

app.use(cors());
app.use(express.json());

// Helper to log debug info
function logDebug(operation, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    operation,
    ...data,
  };
  debugLog.unshift(entry);
  if (debugLog.length > 50) debugLog.pop();
  console.log(`[Debug] ${operation}:`, JSON.stringify(data));
}

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "personal-agent-webhook",
    version: VERSION,
    deploy_time: DEPLOY_TIME,
    events_stored: events.length,
    pending_calls: pendingCalls.size,
    active_conferences: activeConferences.size,
    pending_ai_callbacks: pendingAICallbacks.size,
    timestamp: new Date().toISOString(),
  });
});

// Debug endpoint
app.get("/debug", (req, res) => {
  res.json({
    version: VERSION,
    deploy_time: DEPLOY_TIME,
    pending_calls: Array.from(pendingCalls.entries()),
    active_conferences: Array.from(activeConferences.entries()),
    pending_ai_callbacks: Array.from(pendingAICallbacks.entries()),
    recent_operations: debugLog.slice(0, 20),
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
 */
async function createConference(name, callControlId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { success: false, error: "No API key" };

  try {
    console.log(`[Telnyx] Creating conference ${name} with call ${callControlId}`);
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
      const errorMsg = errorData.errors?.[0]?.detail || `API error: ${response.status}`;
      console.error(`[Telnyx] Conference creation failed: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const data = await response.json();
    console.log(`[Telnyx] Conference created: ${data.data.id}`);
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
 * Trigger ElevenLabs to make an outbound call
 * Uses the ElevenLabs outbound API to have the AI call a bridge number
 * which then gets joined to our conference
 *
 * API: POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call
 */
async function triggerElevenLabsOutbound(agentId, phoneNumberId, toNumber) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("[ElevenLabs] No API key configured");
    return { success: false, error: "No ElevenLabs API key" };
  }

  try {
    console.log(`[ElevenLabs] Triggering outbound call: agent=${agentId}, to=${toNumber}`);

    const response = await fetch(
      "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: agentId,
          agent_phone_number_id: phoneNumberId,
          to_number: toNumber,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data.detail?.message || data.detail || data.message || `API error: ${response.status}`;
      console.error(`[ElevenLabs] Outbound call failed: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    console.log(`[ElevenLabs] Outbound call initiated:`, data);
    return {
      success: data.success !== false,
      conversationId: data.conversation_id,
      sipCallId: data.sip_call_id,
      message: data.message,
    };
  } catch (error) {
    console.error("[ElevenLabs] Error triggering outbound call:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Handle call.initiated
 * - For regular inbound calls: answer and mark pending for conference setup
 * - For ElevenLabs callback calls: just mark as pending AI callback
 */
async function handleCallInitiated(payload) {
  const callControlId = payload?.call_control_id;
  const to = payload?.to;
  const from = payload?.from;
  const direction = payload?.direction;

  if (!callControlId || (direction !== "inbound" && direction !== "incoming")) {
    return;
  }

  // Check if this is an ElevenLabs AI callback (AI calling the bridge number)
  const callbackKey = `${from}->${to}`;
  const pendingCallback = pendingAICallbacks.get(callbackKey);

  if (pendingCallback) {
    console.log(`[Webhook] ElevenLabs AI callback detected: ${from} -> ${to}`);
    logDebug("ai_callback_initiated", { callControlId, from, to, conferenceId: pendingCallback.conferenceId });

    // Answer the AI call
    const answerResult = await answerCall(callControlId);
    if (!answerResult.success) {
      console.error(`[Webhook] Failed to answer AI callback: ${answerResult.error}`);
      return;
    }

    // Store for joining on call.answered
    activeConferences.set(callControlId, {
      conferenceId: pendingCallback.conferenceId,
      agentName: pendingCallback.agentName,
      callerFrom: pendingCallback.callerFrom,
      isAICallback: true,
    });

    pendingAICallbacks.delete(callbackKey);
    return;
  }

  // Check if this is a call to one of our agent numbers (regular caller)
  const agentConfig = AGENT_PHONE_NUMBERS[to];
  if (!agentConfig) {
    console.log(`[Webhook] Inbound call to ${to} - not an agent number, ignoring`);
    return;
  }

  console.log(`[Webhook] Inbound call from ${from} to ${agentConfig.agentName} (${to})`);
  logDebug("call_initiated", { callControlId, from, to, agent: agentConfig.agentName });

  // Store pending info - we'll set up the conference when we get call.answered
  pendingCalls.set(callControlId, {
    from,
    to,
    agentConfig,
    timestamp: Date.now(),
  });

  // Answer the call - conference setup will happen in handleCallAnswered
  console.log(`[Webhook] Answering call...`);
  const answerResult = await answerCall(callControlId);
  logDebug("answer_call", { callControlId, success: answerResult.success, error: answerResult.error });

  if (!answerResult.success) {
    console.error(`[Webhook] Failed to answer: ${answerResult.error}`);
    pendingCalls.delete(callControlId);
    return;
  }

  console.log(`[Webhook] Call answered, waiting for call.answered event to set up conference`);
}

/**
 * Handle call.answered
 * - For inbound calls: set up conference and trigger ElevenLabs outbound
 * - For AI callback calls: join to conference
 */
async function handleCallAnswered(payload) {
  const callControlId = payload?.call_control_id;

  // Check if this is an AI callback we're tracking
  const confInfo = activeConferences.get(callControlId);
  if (confInfo && confInfo.isAICallback) {
    console.log(`[Webhook] AI callback answered! Joining to conference ${confInfo.conferenceId}`);

    const joinResult = await joinConference(confInfo.conferenceId, callControlId);
    logDebug("join_ai_to_conference", {
      conferenceId: confInfo.conferenceId,
      callControlId,
      success: joinResult.success,
      error: joinResult.error,
    });

    if (!joinResult.success) {
      console.error(`[Webhook] Failed to join AI to conference: ${joinResult.error}`);
      return;
    }

    // Update conference info (no longer just a callback, now fully connected)
    confInfo.isAICallback = false;
    confInfo.aiCallControlId = callControlId;

    console.log(`[Webhook] Call connected! Caller <-> ${confInfo.agentName}`);
    logDebug("call_connected", {
      agent: confInfo.agentName,
      callerFrom: confInfo.callerFrom,
      conferenceId: confInfo.conferenceId,
    });
    return;
  }

  // Check if this is an inbound call pending conference setup
  const pendingInfo = pendingCalls.get(callControlId);
  logDebug("call_answered_check", {
    callControlId,
    hasPendingInfo: !!pendingInfo,
    pendingCallsSize: pendingCalls.size,
  });

  if (pendingInfo) {
    pendingCalls.delete(callControlId);
    console.log(`[Webhook] Inbound call now answered, setting up conference...`);

    // Create conference with caller
    const confName = `call_${Date.now()}`;
    const confResult = await createConference(confName, callControlId);
    logDebug("create_conference", {
      confName,
      callControlId,
      success: confResult.success,
      conferenceId: confResult.conferenceId,
      error: confResult.error,
    });

    if (!confResult.success) {
      console.error(`[Webhook] Failed to create conference: ${confResult.error}`);
      return;
    }

    console.log(`[Webhook] Conference created: ${confResult.conferenceId}`);

    // Trigger ElevenLabs outbound call to bridge number
    const agentConfig = pendingInfo.agentConfig;
    const bridgeNumber = agentConfig.bridgeNumber;

    console.log(`[Webhook] Triggering ElevenLabs ${agentConfig.agentName} to call ${bridgeNumber}...`);

    // Register expected callback BEFORE triggering outbound
    // Key is "agentNumber->bridgeNumber" since that's how the call will appear
    const callbackKey = `${pendingInfo.to}->${bridgeNumber}`;
    pendingAICallbacks.set(callbackKey, {
      conferenceId: confResult.conferenceId,
      agentName: agentConfig.agentName,
      callerFrom: pendingInfo.from,
      timestamp: Date.now(),
    });

    logDebug("registered_ai_callback", {
      callbackKey,
      conferenceId: confResult.conferenceId,
      agentName: agentConfig.agentName,
    });

    const outboundResult = await triggerElevenLabsOutbound(
      agentConfig.agentId,
      agentConfig.phoneNumberId,
      bridgeNumber
    );

    logDebug("elevenlabs_outbound", {
      agentId: agentConfig.agentId,
      phoneNumberId: agentConfig.phoneNumberId,
      bridgeNumber,
      success: outboundResult.success,
      conversationId: outboundResult.conversationId,
      error: outboundResult.error,
    });

    if (!outboundResult.success) {
      console.error(`[Webhook] Failed to trigger ElevenLabs outbound: ${outboundResult.error}`);
      pendingAICallbacks.delete(callbackKey);
      return;
    }

    console.log(`[Webhook] ElevenLabs outbound initiated. Waiting for AI to call ${bridgeNumber}...`);
    return;
  }
}

/**
 * Handle call.hangup - cleanup
 */
function handleCallHangup(payload) {
  const callControlId = payload?.call_control_id;

  if (pendingCalls.has(callControlId)) {
    console.log(`[Webhook] Pending call ended before setup`);
    pendingCalls.delete(callControlId);
  }

  if (activeConferences.has(callControlId)) {
    console.log(`[Webhook] Call ended, cleaning up conference tracking`);
    activeConferences.delete(callControlId);
  }
}

// Cleanup stale pending callbacks (older than 60 seconds)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingAICallbacks.entries()) {
    if (now - value.timestamp > 60000) {
      console.log(`[Cleanup] Removing stale AI callback: ${key}`);
      pendingAICallbacks.delete(key);
    }
  }
}, 30000);

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

  console.log(`[Webhook] Received: ${data.event_type}`);

  // Add to events array (FIFO)
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.pop();
  }

  // Handle different event types
  if (data.event_type === "call.initiated") {
    handleCallInitiated(data.payload).catch((err) => {
      console.error("[Webhook] Error handling inbound call:", err.message);
    });
  } else if (data.event_type === "call.answered") {
    handleCallAnswered(data.payload).catch((err) => {
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
  const confs = Array.from(activeConferences.entries()).map(
    ([callControlId, info]) => ({
      callControlId,
      ...info,
    })
  );
  res.json({ success: true, conferences: confs });
});

// Clear events (for testing)
app.delete("/events", (req, res) => {
  events.length = 0;
  res.json({ success: true, message: "Events cleared" });
});

app.listen(PORT, () => {
  console.log(`Personal Agent Webhook server running on port ${PORT}`);
  console.log(`Version: ${VERSION}`);
  console.log(`Webhook endpoint: POST /telnyx-webhook`);
  console.log(`Events endpoint: GET /events`);
  console.log(`Conferences endpoint: GET /conferences`);
  if (process.env.TELNYX_API_KEY) {
    console.log(`Telnyx API key configured`);
  } else {
    console.log(`WARNING: No TELNYX_API_KEY`);
  }
  if (process.env.ELEVENLABS_API_KEY) {
    console.log(`ElevenLabs API key configured`);
  } else {
    console.log(`WARNING: No ELEVENLABS_API_KEY - AI outbound calls disabled`);
  }
});
